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

// On-disk validation is deliberately stricter than the public session value
// parser. A mutation reserializes the whole file, so accepting and stripping
// unknown persisted fields would silently destroy data written by another
// version or placed at the wrong path.
const PersistedStoredSession = StoredSession.strict();

export const SessionFile = z
  .object({
    version: z.literal(2),
    sessions: z.record(z.string(), PersistedStoredSession),
  })
  .strict()
  .superRefine((file, context) => {
    for (const [host, session] of Object.entries(file.sessions)) {
      if (host !== session.host) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'session record key must match session host',
          path: ['sessions', host, 'host'],
        });
      }
    }
  });
export type SessionFile = z.infer<typeof SessionFile>;
