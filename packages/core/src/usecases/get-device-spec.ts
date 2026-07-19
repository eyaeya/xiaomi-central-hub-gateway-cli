import { type FetchMiotSpecOptions, fetchMiotSpec } from '../http-client.js';
import { type DeviceSpec, DeviceSpecSchema } from '../schemas/device-spec.js';
import { parseOrThrow } from '../transport/errors.js';

export type GetDeviceSpecOptions = FetchMiotSpecOptions;

export async function getDeviceSpec(
  urn: string,
  opts: GetDeviceSpecOptions = {},
): Promise<DeviceSpec> {
  const raw = await fetchMiotSpec(urn, opts);
  return parseOrThrow(DeviceSpecSchema, raw, 'DeviceSpec');
}
