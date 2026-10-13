// SPDX-License-Identifier: GPL-3.0-or-later
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CloudGatewayPasscode, CloudGatewayUrl } from '../schemas/cloud-gateway.js';
import { SessionStore } from '../session/store.js';
import { ConfigError, SchemaError } from '../transport/errors.js';
import { type LoginInputs, type LoginResult, login } from '../usecases/login.js';
import { status } from '../usecases/status.js';
import type { CloudTransport } from './transport.js';

export interface CloudGatewayLoginOptions {
  did: string;
  baseUrl?: string;
  sessionFile?: string;
  agentBinary: LoginInputs['agentBinary'];
  /** Injectable seams keep tests off both the real gateway and filesystem. */
  login?: (input: LoginInputs) => Promise<LoginResult>;
  isLive?: (baseUrl: string, sessionFile: string) => Promise<boolean>;
}

export interface CloudGatewayLoginResult {
  ok: true;
  host: string;
  reused: boolean;
  source: 'mijia-cloud';
}

function safeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('Gateway address must be an HTTP(S) URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '' && url.pathname !== '/')
  ) {
    throw new ConfigError('Gateway address must be an HTTP(S) origin without credentials or query');
  }
  return url.origin;
}

/** Retrieve a fresh code only when needed, then pass it directly to the gateway login usecase. */
export async function loginGatewayViaCloud(
  transport: CloudTransport,
  options: CloudGatewayLoginOptions,
): Promise<CloudGatewayLoginResult> {
  if (!options.did || !/^[A-Za-z0-9._-]+$/.test(options.did)) {
    throw new ConfigError('A valid explicit gateway --did is required');
  }
  const path = `/home/rpc/${encodeURIComponent(options.did)}`;
  let baseUrl = options.baseUrl;
  if (!baseUrl) {
    const response = CloudGatewayUrl.safeParse(
      await transport.request(path, { method: 'miIO.get_autowebconfig_url', params: [] }),
    );
    if (!response.success) {
      throw new SchemaError('Cloud gateway URL response does not match the verified shape', {
        domain: 'cloud',
      });
    }
    baseUrl = response.data.url;
  }
  baseUrl = safeBaseUrl(baseUrl);
  const sessionFile = options.sessionFile ?? join(homedir(), '.xgg', 'session.json');
  const isLive = options.isLive ?? liveGatewaySession;
  if (await isLive(baseUrl, sessionFile)) {
    return { ok: true, host: baseUrl, reused: true, source: 'mijia-cloud' };
  }
  const raw = await transport.request(path, {
    method: 'miIO.get_central_link_passcode',
    params: [],
  });
  const parsed = CloudGatewayPasscode.safeParse(raw);
  if (!parsed.success) {
    // Never expose the raw response or zod received values from a credential endpoint.
    throw new SchemaError('Cloud gateway passcode response does not match the verified shape', {
      domain: 'cloud',
    });
  }
  await (options.login ?? login)({
    baseUrl,
    passcode: parsed.data.passcode,
    agentBinary: options.agentBinary,
    sessionFile,
  });
  return { ok: true, host: baseUrl, reused: false, source: 'mijia-cloud' };
}

async function liveGatewaySession(baseUrl: string, sessionFile: string): Promise<boolean> {
  try {
    return (await status({ baseUrl, store: new SessionStore({ path: sessionFile }) })).live;
  } catch {
    return false;
  }
}
