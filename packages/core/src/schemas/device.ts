import { z } from 'zod';

export const Device = z
  .object({
    specV2Access: z.boolean(),
    specV3Access: z.boolean(),
    online: z.boolean(),
    pushAvailable: z.boolean(),
    name: z.string(),
    model: z.string(),
    modelName: z.string(),
    urn: z.string(),
    roomId: z.string(),
    roomName: z.string(),
    icon: z.string(),
    category: z.string().optional(),
    zigbee: z.boolean().optional(),
    bluetooth: z.boolean().optional(),
    cloud: z.boolean().optional(),
  })
  .passthrough();
export type Device = z.infer<typeof Device>;

export type DeviceEligibilityFields = Pick<Device, 'online' | 'specV2Access' | 'specV3Access'>;

/**
 * The web UI hides this inventory bucket and autoLocal cannot route to it.
 * Keep the predicate in Core so read views and write-safety funnels agree.
 */
export function isGhostDevice(device: DeviceEligibilityFields): boolean {
  return device.online && !device.specV2Access && !device.specV3Access;
}

export const DeviceListResponse = z.object({
  devList: z.record(Device),
});
export type DeviceListResponse = z.infer<typeof DeviceListResponse>;
