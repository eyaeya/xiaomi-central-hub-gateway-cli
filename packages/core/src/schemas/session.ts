import { z } from 'zod';

export const StoredSession = z.object({
  host: z.string().url(),
  pid: z.number().int().positive(),
  socketPath: z.string().min(1),
  agentStartedAt: z.string().datetime(),
  agentVersion: z.string().min(1),
  lastValidatedAt: z.string().datetime(),
});
export type StoredSession = z.infer<typeof StoredSession>;

export const SessionFile = z.object({
  version: z.literal(2),
  sessions: z.record(z.string(), StoredSession),
});
export type SessionFile = z.infer<typeof SessionFile>;
