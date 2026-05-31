import { fetchMiotSpec } from '../http-client.js';
import { type DeviceSpec, DeviceSpecSchema } from '../schemas/device-spec.js';
import { parseOrThrow } from '../transport/errors.js';

export interface GetDeviceSpecOptions {
  timeoutMs?: number;
  baseUrl?: string;
}

export async function getDeviceSpec(
  urn: string,
  opts: GetDeviceSpecOptions = {},
): Promise<DeviceSpec> {
  const raw = await fetchMiotSpec(urn, opts);
  return parseOrThrow(DeviceSpecSchema, raw, 'DeviceSpec');
}
