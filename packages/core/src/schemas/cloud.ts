// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from 'zod';

// Cloud APIs include tokens, location and network identifiers. Objects deliberately
// strip unknown keys rather than passing private response fields to CLI output.
const Id = z.union([z.string().min(1), z.number().int().safe()]).transform(String);
const Value = z.union([z.boolean(), z.number().finite(), z.string()]);
export const CloudHome = z.object({
  id: Id,
  name: z.string(),
  uid: z.number().int().safe(),
  roomlist: z
    .array(z.object({ id: Id, name: z.string(), dids: z.array(Id).nullable().optional() }))
    .optional(),
});
export const CloudHomesResult = z.object({ homelist: z.array(CloudHome) });
export const CloudDevice = z.object({
  did: Id,
  name: z.string(),
  model: z.string(),
  isOnline: z.boolean().optional(),
  spec_type: z.string().optional(),
  home_id: Id.optional(),
});
// owner is a marker used only to select shared devices; never included in output.
const CloudDeviceWithOwner = CloudDevice.extend({ owner: z.unknown().optional() });
export const CloudDevicesResult = z.object({
  device_info: z.array(CloudDevice).default([]),
  has_more: z.boolean().optional(),
  max_did: z.string().optional(),
});
export const CloudSharedDevicesResult = z.object({
  list: z.array(CloudDeviceWithOwner),
  has_more: z.boolean().optional(),
  next_start_did: z.string().optional(),
});

export const CloudSpecProperty = z.object({
  iid: z.number().int().positive(),
  type: z.string().min(1),
  description: z.string(),
  comment: z.string().optional(),
  format: z.string().min(1),
  access: z.array(z.string()).default([]),
  unit: z.string().optional(),
  'value-range': z
    .tuple([z.number().finite(), z.number().finite(), z.number().finite()])
    .optional(),
  'value-list': z
    .array(z.object({ value: Value, description: z.string(), comment: z.string().optional() }))
    .optional(),
});
export const CloudSpecAction = z.object({
  iid: z.number().int().positive(),
  type: z.string().min(1),
  description: z.string(),
  comment: z.string().optional(),
  in: z.array(z.number().int().positive()).default([]),
  out: z.array(z.number().int().positive()).default([]),
});
export const CloudSpecResult = z.object({
  type: z.string(),
  description: z.string(),
  services: z.array(
    z.object({
      iid: z.number().int().positive(),
      type: z.string().min(1),
      description: z.string(),
      properties: z.array(CloudSpecProperty).default([]),
      actions: z.array(CloudSpecAction).default([]),
    }),
  ),
});
export const CloudPropertyResult = z.object({
  did: Id,
  siid: z.number().int().positive(),
  piid: z.number().int().positive(),
  code: z.number().int(),
  value: Value.optional(),
  updateTime: z.number().int().nonnegative().optional(),
});
export const CloudPropertiesResult = z.array(CloudPropertyResult);
export const CloudActionResult = z.object({
  did: Id,
  siid: z.number().int().positive(),
  aiid: z.number().int().positive(),
  code: z.number().int(),
  out: z.array(z.object({ piid: z.number().int().positive(), value: Value })).optional(),
});
export const CloudScene = z.object({ scene_id: Id, name: z.string() });
export const CloudScenesResult = z.object({
  manual_scene_info_list: z.array(CloudScene).default([]),
});
export const CloudRunSceneResult = z.union([
  z.boolean(),
  z.object({ code: z.number().int(), scene_id: Id.optional() }),
]);
const ConsumableDetail = z.object({
  id: Id.optional(),
  description: z.string().optional(),
  value: z.union([z.string(), z.number()]).optional(),
  consumable_type: z.string().optional(),
});
export const CloudConsumable = z.object({
  did: Id,
  name: z.string(),
  details: z.union([ConsumableDetail, z.array(ConsumableDetail)]).optional(),
});
export const CloudConsumablesResult = z.object({
  items: z.array(z.object({ consumes_data: z.array(CloudConsumable).default([]) })).default([]),
});
export const CloudStatisticsRequest = z
  .object({
    did: z.string().min(1),
    key: z.string().min(1),
    data_type: z.enum([
      'stat_hour',
      'stat_day',
      'stat_week',
      'stat_month',
      'stat_hour_v3',
      'stat_day_v3',
      'stat_week_v3',
      'stat_month_v3',
    ]),
    limit: z.number().int().positive().max(1000),
    time_start: z.number().int().nonnegative(),
    time_end: z.number().int().nonnegative(),
  })
  .refine((data) => data.time_end >= data.time_start, 'time_end must not precede time_start');
export const CloudStatisticsResult = z.array(
  z.object({ value: z.string(), time: z.number().int().nonnegative() }),
);
