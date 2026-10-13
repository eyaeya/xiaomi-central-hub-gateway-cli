// SPDX-License-Identifier: GPL-3.0-or-later
/** Xiaomi account QR/refresh flow adapted from Do1e/mijia-api 5.0.0 (GPL-3.0-or-later). */
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  AuthRequiredError,
  ConfigError,
  NetworkError,
  SchemaError,
  XggError,
} from '../transport/errors.js';

export interface CloudStore {
  read(path: string): Promise<unknown | undefined>;
  write(path: string, value: unknown): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface CloudRuntimeOptions {
  authFile?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  store?: CloudStore;
  now?: () => number;
  signal?: AbortSignal;
}

export interface CloudLoginStartOptions extends CloudRuntimeOptions {
  /** Replace pending QR authorization and permit recovery from a corrupt credential file. */
  restart?: boolean;
}

export interface CloudLoginCompleteOptions extends CloudRuntimeOptions {
  /** A bounded polling window, independent of the normal HTTP timeout. */
  waitMs?: number;
}

export interface CloudLoginPending {
  authenticated: false;
  status: 'pending';
  qrUrl: string;
  loginUrl: string;
  expiresAt: string;
  nextAction: 'xgg cloud login --complete';
  reused: boolean;
}

export type CloudLoginResult = { authenticated: true } | CloudLoginPending;

const headerString = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\r\n;]/.test(value));
const CredentialSchema = z
  .object({
    ua: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !/[\r\n]/.test(value))
      .optional(),
    ssecurity: z
      .string()
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      .optional(),
    userId: z.union([headerString, z.number().finite()]).transform(String).optional(),
    cUserId: headerString.optional(),
    serviceToken: headerString.optional(),
    passToken: headerString.optional(),
    deviceId: headerString.optional(),
    pass_o: headerString.optional(),
  })
  .passthrough();
export type CloudCredentials = z.infer<typeof CredentialSchema>;
export type ReadyCloudCredentials = CloudCredentials & {
  ua: string;
  ssecurity: string;
  cUserId: string;
  serviceToken: string;
};

const pendingSchema = z.object({
  version: z.literal(1),
  expiresAt: z.number().finite(),
  credentials: CredentialSchema,
  login: z.object({ lp: z.string().url(), loginUrl: z.string().url(), qr: z.string().url() }),
});
const accountSchema = z
  .object({
    code: z.number().optional(),
    location: z.string().optional(),
    ssecurity: z.string().optional(),
  })
  .passthrough();

const privateStore: CloudStore = {
  async read(path) {
    try {
      const raw = await fs.readFile(path, 'utf8');
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        throw new SchemaError('Cloud credential file is not valid JSON', {
          domain: 'cloud',
          reason: 'invalid-credentials',
        });
      }
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
        return undefined;
      if (error instanceof XggError) throw error;
      throw new ConfigError('Unable to read cloud credentials', { domain: 'cloud' });
    }
  },
  async write(path, value) {
    const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, path);
    } catch {
      await fs.unlink(temporary).catch(() => {});
      throw new ConfigError('Unable to save private cloud credentials', { domain: 'cloud' });
    }
  },
  async remove(path) {
    try {
      await fs.unlink(path);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
        return;
      throw new ConfigError('Unable to remove cloud credentials', { domain: 'cloud' });
    }
  },
};

export function cloudRuntime(options: CloudRuntimeOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new ConfigError('Cloud timeout must be between 1 and 120 seconds', {
      domain: 'cloud',
    });
  }
  return {
    authFile: options.authFile ?? join(homedir(), '.config', 'mijia-api', 'auth.json'),
    timeoutMs,
    fetch: options.fetch ?? globalThis.fetch,
    store: options.store ?? privateStore,
    now: options.now ?? Date.now,
    signal: options.signal,
  };
}

function authRequired(): AuthRequiredError {
  return new AuthRequiredError(
    'Cloud authorization is missing or expired; run xgg cloud login and scan with the Mi Home app',
    { domain: 'cloud' },
  );
}

export function requireCloudCredentials(value: CloudCredentials): ReadyCloudCredentials {
  if (!value.ua || !value.ssecurity || !value.cUserId || !value.serviceToken) throw authRequired();
  return value as ReadyCloudCredentials;
}

export async function readCloudCredentials(
  options: CloudRuntimeOptions = {},
): Promise<CloudCredentials> {
  const runtime = cloudRuntime(options);
  const value = await runtime.store.read(runtime.authFile);
  if (value === undefined) return {};
  const parsed = CredentialSchema.safeParse(value);
  if (!parsed.success)
    throw new SchemaError('Cloud credential file has an invalid structure', {
      domain: 'cloud',
      reason: 'invalid-credentials',
    });
  return parsed.data;
}

function initializeCredentials(value: CloudCredentials): CloudCredentials {
  const pass_o = value.pass_o ?? randomBytes(8).toString('hex');
  const randomId = randomBytes(20).toString('hex').toUpperCase();
  return {
    ...value,
    pass_o,
    deviceId: value.deviceId ?? randomBytes(12).toString('base64url'),
    ua:
      value.ua ??
      `Android-15-11.0.701-Xiaomi-23046RP50C-OS2.0.212.0.VMYCNXM-${randomId}-CN-${randomBytes(16).toString('hex').toUpperCase()}-${randomBytes(16).toString('hex').toUpperCase()}-SmartHome-MI_APP_STORE-${randomId}|${randomBytes(20).toString('hex').toUpperCase()}|${pass_o}-64`,
  };
}

function checkedAccountUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SchemaError('Cloud account returned an invalid URL', { domain: 'cloud' });
  }
  const allowed = ['account.xiaomi.com', 'mijia.tech', 'api.io.mi.com'];
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !allowed.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
  ) {
    throw new SchemaError('Cloud account returned an untrusted URL', { domain: 'cloud' });
  }
  return url;
}

const responseSignals = new WeakMap<Response, { timeout: AbortSignal; caller?: AbortSignal }>();

/** No remote response bodies, cookies, URLs or fetch causes enter user-visible errors. */
export async function safeCloudFetch(
  url: string,
  init: RequestInit,
  options: CloudRuntimeOptions = {},
): Promise<Response> {
  const runtime = cloudRuntime(options);
  const timeout = AbortSignal.timeout(runtime.timeoutMs);
  const signal = runtime.signal ? AbortSignal.any([runtime.signal, timeout]) : timeout;
  try {
    const response = await runtime.fetch(url, { ...init, signal });
    responseSignals.set(response, {
      timeout,
      ...(runtime.signal && { caller: runtime.signal }),
    });
    return response;
  } catch (error) {
    const timedOut = timeout.aborted || (error instanceof Error && error.name === 'TimeoutError');
    throw new NetworkError('Cloud request failed or timed out', {
      domain: 'cloud',
      ...(runtime.signal?.aborted
        ? { reason: 'cancelled' }
        : timedOut
          ? { reason: 'timeout' }
          : {}),
    });
  }
}

export async function safeCloudText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (text.length > 8 * 1024 * 1024) throw new Error('oversize');
    return text;
  } catch {
    // fetch can resolve headers before a long-poll response body arrives. Preserve
    // timeout/cancellation identity for that phase too, without exposing its cause.
    const signals = responseSignals.get(response);
    throw new NetworkError('Unable to read cloud response', {
      domain: 'cloud',
      ...(signals?.caller?.aborted
        ? { reason: 'cancelled' }
        : signals?.timeout.aborted
          ? { reason: 'timeout' }
          : {}),
    });
  }
}

async function accountJson(
  url: string,
  credentials: CloudCredentials,
  cookie: string,
  options: CloudRuntimeOptions,
): Promise<z.infer<typeof accountSchema>> {
  const response = await safeCloudFetch(
    checkedAccountUrl(url).toString(),
    {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': credentials.ua ?? 'xgg', Cookie: cookie },
    },
    options,
  );
  if (response.status === 401 || response.status === 403) throw authRequired();
  if (!response.ok)
    throw new NetworkError('Cloud account request failed', {
      domain: 'cloud',
      status: response.status,
    });
  const text = await safeCloudText(response);
  try {
    return accountSchema.parse(JSON.parse(text.replace(/^&&&START&&&/, '')));
  } catch {
    throw new SchemaError('Cloud account returned an invalid response', { domain: 'cloud' });
  }
}

function accountCookie(credentials: CloudCredentials): string {
  return [
    ['deviceId', credentials.deviceId],
    ['pass_o', credentials.pass_o],
    ['passToken', credentials.passToken],
    ['userId', credentials.userId],
    ['cUserId', credentials.cUserId],
    ['uLocale', 'zh_CN'],
  ]
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${value}`)
    .join(';');
}

async function finishCallback(
  location: string,
  credentials: CloudCredentials,
  options: CloudRuntimeOptions,
): Promise<ReadyCloudCredentials> {
  let url = checkedAccountUrl(location);
  const cookies: Record<string, string> = {};
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await safeCloudFetch(
      url.toString(),
      {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': credentials.ua ?? 'xgg',
          Cookie: Object.entries(cookies)
            .map(([key, value]) => `${key}=${value}`)
            .join(';'),
        },
      },
      options,
    );
    const headers = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];
    for (const header of headers) {
      for (const item of header.split(/,(?=\s*[^;,=\s]+=)/)) {
        const match = /^\s*([^=;\s]+)=([^;]*)/.exec(item);
        const name = match?.[1];
        const value = match?.[2];
        if (
          name &&
          value !== undefined &&
          ['serviceToken', 'cUserId', 'userId', 'passToken'].includes(name)
        )
          cookies[name] = value;
      }
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get('location');
      if (!next) throw new SchemaError('Cloud callback omitted its redirect', { domain: 'cloud' });
      url = checkedAccountUrl(new URL(next, url).toString());
      continue;
    }
    if (!response.ok) throw authRequired();
    if (!cookies.serviceToken) throw authRequired();
    const parsed = CredentialSchema.safeParse({ ...credentials, ...cookies });
    if (!parsed.success)
      throw new SchemaError('Cloud account returned invalid credentials', { domain: 'cloud' });
    return requireCloudCredentials(parsed.data);
  }
  throw new NetworkError('Too many cloud account redirects', { domain: 'cloud' });
}

async function saveCredentials(
  credentials: ReadyCloudCredentials,
  options: CloudRuntimeOptions,
): Promise<void> {
  const runtime = cloudRuntime(options);
  await runtime.store.write(runtime.authFile, { ...credentials, saveTime: runtime.now() });
}

export async function refreshCloudCredentials(
  options: CloudRuntimeOptions = {},
): Promise<ReadyCloudCredentials> {
  const credentials = initializeCredentials(await readCloudCredentials(options));
  if (!credentials.passToken) throw authRequired();
  const result = await accountJson(
    'https://account.xiaomi.com/pass/serviceLogin?_json=true&sid=mijia&_locale=zh_CN',
    credentials,
    accountCookie(credentials),
    options,
  );
  if (result.code !== 0 || !result.location || !result.ssecurity) throw authRequired();
  const refreshed = await finishCallback(
    result.location,
    { ...credentials, ssecurity: result.ssecurity },
    options,
  );
  await saveCredentials(refreshed, options);
  return refreshed;
}

export async function cloudStatus(
  options: CloudRuntimeOptions = {},
): Promise<{ authenticated: boolean }> {
  const { createCloudTransport } = await import('./transport.js');
  try {
    await createCloudTransport(options).request('/v2/message/v2/check_new_msg', {
      begin_at: Math.floor(cloudRuntime(options).now() / 1000) - 3600,
    });
    return { authenticated: true };
  } catch (error) {
    if (error instanceof AuthRequiredError) return { authenticated: false };
    throw error;
  }
}

function pendingResult(pending: z.infer<typeof pendingSchema>, reused: boolean): CloudLoginPending {
  return {
    authenticated: false,
    status: 'pending',
    qrUrl: pending.login.qr,
    loginUrl: pending.login.loginUrl,
    expiresAt: new Date(pending.expiresAt).toISOString(),
    nextAction: 'xgg cloud login --complete',
    reused,
  };
}

export async function cloudLoginStart(
  options: CloudLoginStartOptions = {},
): Promise<CloudLoginResult> {
  const runtime = cloudRuntime(options);
  const pendingPath = `${runtime.authFile}.pending`;
  if (options.restart) {
    await runtime.store.remove(pendingPath);
    try {
      await readCloudCredentials(options);
    } catch (error) {
      // Only explicit login recovery may discard corrupt credentials. Permission/I/O
      // errors are not corruption and must not delete the user's existing auth file.
      if (!(error instanceof SchemaError)) throw error;
      await runtime.store.remove(runtime.authFile);
    }
  }
  if ((await cloudStatus(options)).authenticated) {
    await runtime.store.remove(pendingPath);
    return { authenticated: true };
  }
  if (!options.restart) {
    let rawPending: unknown;
    try {
      rawPending = await runtime.store.read(pendingPath);
    } catch (error) {
      if (!(error instanceof SchemaError)) throw error;
    }
    const pending = pendingSchema.safeParse(rawPending);
    if (pending.success && pending.data.expiresAt > runtime.now()) {
      checkedAccountUrl(pending.data.login.lp);
      checkedAccountUrl(pending.data.login.qr);
      checkedAccountUrl(pending.data.login.loginUrl);
      return pendingResult(pending.data, true);
    }
    await runtime.store.remove(pendingPath);
  }
  const credentials = initializeCredentials(await readCloudCredentials(options));
  const service = await accountJson(
    'https://account.xiaomi.com/pass/serviceLogin?_json=true&sid=mijia&_locale=zh_CN',
    credentials,
    accountCookie(credentials),
    options,
  );
  if (service.code === 0 && service.location && service.ssecurity) {
    await saveCredentials(
      await finishCallback(
        service.location,
        { ...credentials, ssecurity: service.ssecurity },
        options,
      ),
      options,
    );
    await runtime.store.remove(`${runtime.authFile}.pending`);
    return { authenticated: true };
  }
  if (!service.location)
    throw new SchemaError('Cloud account omitted QR login parameters', { domain: 'cloud' });
  const query = checkedAccountUrl(service.location).searchParams;
  for (const [key, value] of Object.entries({
    theme: '',
    bizDeviceType: '',
    _hasLogo: 'false',
    _qrsize: '240',
    _dc: String(runtime.now()),
  }))
    query.set(key, value);
  const result = await accountJson(
    `https://account.xiaomi.com/longPolling/loginUrl?${query.toString()}`,
    credentials,
    '',
    options,
  );
  const parsed = pendingSchema.shape.login.safeParse(result);
  if (result.code !== 0 || !parsed.success)
    throw new SchemaError('Cloud account returned invalid QR login data', { domain: 'cloud' });
  checkedAccountUrl(parsed.data.lp);
  checkedAccountUrl(parsed.data.qr);
  checkedAccountUrl(parsed.data.loginUrl);
  const pending: z.infer<typeof pendingSchema> = {
    version: 1,
    expiresAt: runtime.now() + 120_000,
    credentials,
    login: parsed.data,
  };
  await runtime.store.write(pendingPath, pending);
  return pendingResult(pending, false);
}

export async function cloudLoginComplete(
  options: CloudLoginCompleteOptions = {},
): Promise<CloudLoginResult> {
  const runtime = cloudRuntime(options);
  const waitMs = options.waitMs ?? 20_000;
  if (!Number.isInteger(waitMs) || waitMs <= 0 || waitMs > 60_000) {
    throw new ConfigError('Cloud login wait must be between 1 and 60000 milliseconds', {
      domain: 'cloud',
    });
  }
  const pendingPath = `${runtime.authFile}.pending`;
  const parsed = pendingSchema.safeParse(await runtime.store.read(pendingPath));
  if (!parsed.success) throw authRequired();
  const pending = parsed.data;
  const remaining = pending.expiresAt - runtime.now();
  if (remaining <= 0) {
    await runtime.store.remove(pendingPath);
    throw new AuthRequiredError('Cloud QR authorization expired; run xgg cloud login again', {
      domain: 'cloud',
      reason: 'qr-expired',
    });
  }
  let login: z.infer<typeof accountSchema>;
  try {
    login = await accountJson(pending.login.lp, pending.credentials, '', {
      ...options,
      timeoutMs: Math.min(waitMs, remaining),
    });
  } catch (error) {
    if (!(error instanceof NetworkError) || error.details?.reason !== 'timeout') throw error;
    if (pending.expiresAt <= runtime.now()) {
      await runtime.store.remove(pendingPath);
      throw new AuthRequiredError('Cloud QR authorization expired; run xgg cloud login again', {
        domain: 'cloud',
        reason: 'qr-expired',
      });
    }
    return pendingResult(pending, true);
  }
  if ((login.code ?? 0) !== 0 || !login.location) throw authRequired();
  const credentials = CredentialSchema.safeParse({
    ...pending.credentials,
    ...Object.fromEntries(
      ['psecurity', 'nonce', 'ssecurity', 'passToken', 'userId', 'cUserId']
        .filter((key) => login[key] !== undefined)
        .map((key) => [key, login[key]]),
    ),
  });
  if (!credentials.success)
    throw new SchemaError('Cloud login returned invalid credentials', { domain: 'cloud' });
  await saveCredentials(await finishCallback(login.location, credentials.data, options), options);
  await runtime.store.remove(pendingPath);
  return { authenticated: true };
}

export async function cloudLogout(options: CloudRuntimeOptions = {}): Promise<void> {
  const runtime = cloudRuntime(options);
  await runtime.store.remove(runtime.authFile);
  await runtime.store.remove(`${runtime.authFile}.pending`);
}
