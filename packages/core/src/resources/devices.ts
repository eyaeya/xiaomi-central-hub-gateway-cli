import type { Device } from '../schemas/device.js';
import { DeviceListResponse } from '../schemas/device.js';
import { NotFoundError, parseOrThrow } from '../transport/errors.js';
import { agentCall } from '../usecases/agent-call.js';
import type { ResourceDeps } from './index.js';

export async function listDevices(deps: ResourceDeps): Promise<Record<string, Device>> {
  const raw = await agentCall({
    baseUrl: deps.baseUrl,
    method: '/api/getDevList',
    params: {},
    store: deps.store,
    ...(deps.ipcClient !== undefined && { ipcClient: deps.ipcClient }),
    ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
  });
  return parseOrThrow(DeviceListResponse, raw, 'DeviceListResponse').devList;
}

export async function getDevice(id: string, deps: ResourceDeps): Promise<Device> {
  const devices = await listDevices(deps);
  const device = devices[id];
  if (!device) {
    throw new NotFoundError(`device not found: ${id}`, { id });
  }
  return device;
}
