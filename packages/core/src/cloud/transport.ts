// SPDX-License-Identifier: GPL-3.0-or-later
/** Cloud protocol adapted from Do1e/mijia-api 5.0.0; see THIRD_PARTY_NOTICES.md. */
import { z } from 'zod';
import {
  AuthRequiredError,
  ConfigError,
  GatewayError,
  NetworkError,
  NotConfirmedError,
  SchemaError,
} from '../transport/errors.js';
import {
  type CloudRuntimeOptions,
  type ReadyCloudCredentials,
  cloudRuntime,
  readCloudCredentials,
  refreshCloudCredentials,
  requireCloudCredentials,
  safeCloudFetch,
  safeCloudText,
} from './auth.js';
import { cloudNonce, decodeCloudResponse, encodeCloudRequest } from './crypto.js';

export type { CloudRuntimeOptions } from './auth.js';
export interface CloudTransport {
  request(
    path: string,
    body: Record<string, unknown>,
    options?: { mutation?: boolean },
  ): Promise<unknown>;
  getSpec(specType: string): Promise<unknown>;
}

const envelopeSchema = z
  .object({ code: z.number().optional(), result: z.unknown().optional() })
  .passthrough();
// Xiaomi cloud clients also observe envelope code 3 for Unauthorized.
// MIoT negative codes are device/service errors, not cloud authentication.
const authCodes = new Set([3, 401, 403]);

export function createCloudTransport(options: CloudRuntimeOptions = {}): CloudTransport {
  const runtime = cloudRuntime(options);
  let credentials: ReadyCloudCredentials | undefined;
  async function loadCredentials(): Promise<ReadyCloudCredentials> {
    if (credentials) return credentials;
    try {
      credentials = requireCloudCredentials(await readCloudCredentials(options));
    } catch (error) {
      if (!(error instanceof AuthRequiredError)) throw error;
      credentials = await refreshCloudCredentials(options);
    }
    return credentials;
  }

  async function perform(
    path: string,
    body: Record<string, unknown>,
    auth: ReadyCloudCredentials,
    mutation = false,
  ): Promise<unknown> {
    const nonce = cloudNonce(runtime.now());
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let response: Response;
    try {
      response = await safeCloudFetch(
        `https://api.mijia.tech/app${path}`,
        {
          method: 'POST',
          redirect: 'manual',
          headers: {
            'User-Agent': auth.ua,
            'accept-encoding': 'identity',
            'Content-Type': 'application/x-www-form-urlencoded',
            'miot-accept-encoding': 'GZIP',
            'miot-encrypt-algorithm': 'ENCRYPT-RC4',
            'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
            Cookie: `cUserId=${auth.cUserId};yetAnotherServiceToken=${auth.serviceToken};serviceToken=${auth.serviceToken};timezone_id=${timezone};channel=MI_APP_STORE;countryCode=CN;PassportDeviceId=${auth.deviceId ?? ''};locale=zh_CN`,
          },
          body: encodeCloudRequest(path, body, auth.ssecurity, nonce).toString(),
        },
        options,
      );
    } catch (error) {
      if (mutation && error instanceof NetworkError)
        throw new NotConfirmedError(
          'Cloud write response was lost; device state is unknown and the command was not retried',
          { domain: 'cloud' },
        );
      throw error;
    }
    if (response.status === 401 || response.status === 403)
      throw new AuthRequiredError('Cloud authorization expired; run xgg cloud login', {
        domain: 'cloud',
      });
    if (!response.ok) {
      if (mutation)
        throw new NotConfirmedError(
          'Cloud write returned an HTTP failure; device state is unknown and the command was not retried',
          { domain: 'cloud', status: response.status },
        );
      throw new NetworkError('Cloud API HTTP request failed', {
        domain: 'cloud',
        status: response.status,
      });
    }
    let text: string;
    try {
      text = await safeCloudText(response);
    } catch (error) {
      if (mutation)
        throw new NotConfirmedError(
          'Cloud write response was interrupted; device state is unknown and the command was not retried',
          { domain: 'cloud' },
        );
      throw error;
    }
    let raw: unknown;
    try {
      raw = decodeCloudResponse(text, auth.ssecurity, nonce);
    } catch {
      if (mutation)
        throw new NotConfirmedError(
          'Cloud write returned an unreadable response; device state is unknown and the command was not retried',
          { domain: 'cloud' },
        );
      throw new SchemaError('Cloud API returned an invalid encrypted response', {
        domain: 'cloud',
      });
    }
    const parsed = envelopeSchema.safeParse(raw);
    if (!parsed.success) {
      if (mutation)
        throw new NotConfirmedError(
          'Cloud write returned an invalid envelope; device state is unknown and the command was not retried',
          { domain: 'cloud' },
        );
      throw new SchemaError('Cloud API returned an invalid envelope', { domain: 'cloud' });
    }
    const code = parsed.data.code ?? 0;
    if (authCodes.has(code))
      throw new AuthRequiredError('Cloud authorization expired; run xgg cloud login', {
        domain: 'cloud',
        cloudCode: code,
      });
    if (code !== 0)
      throw new GatewayError('Cloud API rejected the request', {
        domain: 'cloud',
        cloudCode: code,
      });
    if (!Object.hasOwn(parsed.data, 'result')) {
      if (mutation)
        throw new NotConfirmedError(
          'Cloud write omitted its result; device state is unknown and the command was not retried',
          { domain: 'cloud' },
        );
      throw new SchemaError('Cloud API omitted its result', { domain: 'cloud' });
    }
    return parsed.data.result;
  }

  async function readWithRefresh(path: string, body: Record<string, unknown>): Promise<unknown> {
    try {
      return await perform(path, body, await loadCredentials());
    } catch (error) {
      if (!(error instanceof AuthRequiredError)) throw error;
      credentials = await refreshCloudCredentials(options);
      return perform(path, body, credentials);
    }
  }

  return {
    async request(path, body, requestOptions = {}) {
      if (
        !/^\/[A-Za-z0-9_./-]+$/.test(path) ||
        path.split('/').some((segment) => segment === '..' || segment === '.')
      )
        throw new ConfigError('Invalid cloud API path', { domain: 'cloud' });
      if (requestOptions.mutation) {
        // Authenticate before physical writes. Once sent, a write is never replayed.
        await readWithRefresh('/v2/message/v2/check_new_msg', {
          begin_at: Math.floor(runtime.now() / 1000) - 3600,
        });
        return perform(path, body, await loadCredentials(), true);
      }
      return readWithRefresh(path, body);
    },
    async getSpec(specType) {
      if (!/^urn:miot-spec-v2:device:[a-zA-Z0-9:_-]+$/.test(specType))
        throw new ConfigError('Expected a MIoT device spec URN', { domain: 'cloud' });
      const response = await safeCloudFetch(
        `https://miot-spec.org/miot-spec-v2/instance?${new URLSearchParams({ type: specType })}`,
        {
          method: 'GET',
          redirect: 'error',
          headers: { 'User-Agent': 'xgg/mijia-cloud' },
        },
        options,
      );
      if (!response.ok)
        throw new NetworkError('Unable to fetch MIoT device specification', {
          domain: 'cloud',
          status: response.status,
        });
      try {
        return JSON.parse(await safeCloudText(response)) as unknown;
      } catch {
        throw new SchemaError('MIoT device specification is not valid JSON', { domain: 'cloud' });
      }
    },
  };
}
