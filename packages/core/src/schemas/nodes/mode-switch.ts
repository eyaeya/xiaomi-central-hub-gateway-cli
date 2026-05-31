import { z } from 'zod';
import { Connection, NodeId, Position } from './common.js';

export const ModeSwitchCfg = z
  .object({
    urn: z.string().optional(),
    pos: Position,
    name: z.string(),
    version: z.number(),
  })
  .strict();
export type ModeSwitchCfg = z.infer<typeof ModeSwitchCfg>;

export const ModeSwitchProps = z.object({}).strict();
export type ModeSwitchProps = z.infer<typeof ModeSwitchProps>;

export const ModeSwitchInputs = z
  .object({
    input: z.null(),
  })
  .strict();
export type ModeSwitchInputs = z.infer<typeof ModeSwitchInputs>;

// F6 (2026-05-28 skill-walk): tutorial 06 demos 5+ modes; gateway accepts
// any `output<digits>` key (output0..outputN-1). Strict-where-known:
// the record's key schema accepts only `output<digits>`, and a refine
// requires the canonical floor `output0` + `output1` (a 1-mode modeSwitch
// is degenerate — gateway never produces such a shape).
// F43 (2026-05-30) — bundle Pr.modeSwitch iterates
// `for (let r = 0; r < Object.keys.length; r++)` asserting every
// `output${r}` is present; non-contiguous keys (e.g. output0/output1/
// output99) return "output${i} missing". Strengthen the refine to
// enforce contiguity, not just the output0/output1 floor.
export const ModeSwitchOutputs = z
  .record(
    z.string().regex(/^output\d+$/, {
      message: 'modeSwitch outputs may only contain output<digits> keys',
    }),
    z.array(Connection),
  )
  .refine(
    (obj) => {
      const n = Object.keys(obj).length;
      if (n < 2) return false;
      for (let i = 0; i < n; i += 1) {
        if (!(`output${i}` in obj)) return false;
      }
      return true;
    },
    {
      message:
        'modeSwitch outputs must form the contiguous range output0..output(N-1) — gateway rejects non-contiguous keys with "outputN missing"',
    },
  );
export type ModeSwitchOutputs = z.infer<typeof ModeSwitchOutputs>;

export const ModeSwitchNode = z
  .object({
    type: z.literal('modeSwitch'),
    id: NodeId,
    cfg: ModeSwitchCfg,
    inputs: ModeSwitchInputs,
    outputs: ModeSwitchOutputs,
    props: ModeSwitchProps,
  })
  .strict();
export type ModeSwitchNode = z.infer<typeof ModeSwitchNode>;
