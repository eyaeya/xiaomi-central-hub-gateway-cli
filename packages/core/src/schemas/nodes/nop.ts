import { z } from 'zod';
import { NodeId, Position } from './common.js';

// Quill stores a document as an array of insert operations. The official
// gateway editor persists `quill.getContents().ops` directly in
// `cfg.contents`; formatting lives in each operation's optional `attributes`
// record. Keep attribute/embed payloads JSON-shaped but otherwise open so a
// newer Quill format is preserved without weakening the surrounding node
// schema.
export type QuillJsonValue =
  | null
  | boolean
  | number
  | string
  | QuillJsonValue[]
  | { [key: string]: QuillJsonValue };

const QuillJsonValueSchema: z.ZodType<QuillJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(QuillJsonValueSchema),
    z.record(z.string(), QuillJsonValueSchema),
  ]),
);

const QuillEmbed = z
  .record(z.string(), QuillJsonValueSchema)
  .refine((value) => Object.keys(value).length === 1, {
    message: 'Quill embed inserts must contain exactly one blot key',
  });

export const NopDeltaOperation = z
  .object({
    insert: z.union([z.string(), QuillEmbed]),
    attributes: z.record(z.string(), QuillJsonValueSchema).optional(),
  })
  .strict();
export type NopDeltaOperation = z.infer<typeof NopDeltaOperation>;

export const NopContents = z.array(NopDeltaOperation);
export type NopContents = z.infer<typeof NopContents>;

export const NopCfg = z
  .object({
    pos: Position,
    name: z.string(),
    version: z.number().int(),
    contents: NopContents,
    background: z.string().min(1),
  })
  .strict();
export type NopCfg = z.infer<typeof NopCfg>;

export const NopProps = z.object({}).strict();
export type NopProps = z.infer<typeof NopProps>;

export const NopInputs = z.object({}).strict();
export type NopInputs = z.infer<typeof NopInputs>;

// The serialized UI model retains an `output: []` placeholder, but its
// connector list is empty. Reject non-empty arrays so a note can never be
// mistaken for an executable graph node.
export const NopOutputs = z
  .object({
    output: z.array(z.never()).max(0, 'nop is a canvas note and has no output connector'),
  })
  .strict();
export type NopOutputs = z.infer<typeof NopOutputs>;

export const NopNode = z
  .object({
    type: z.literal('nop'),
    id: NodeId,
    cfg: NopCfg,
    inputs: NopInputs,
    outputs: NopOutputs,
    props: NopProps,
  })
  .strict();
export type NopNode = z.infer<typeof NopNode>;
