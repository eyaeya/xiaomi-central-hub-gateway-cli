import { z } from 'zod';

import { NodeId } from './common.js';

export const UnknownNode = z
  .object({
    type: z.string().min(1),
    id: NodeId,
  })
  .passthrough();
export type UnknownNode = z.infer<typeof UnknownNode>;
