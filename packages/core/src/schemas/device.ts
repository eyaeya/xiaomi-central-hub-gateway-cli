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

export const DeviceListResponse = z.object({
  devList: z.record(Device),
});
export type DeviceListResponse = z.infer<typeof DeviceListResponse>;
