import { z } from 'zod';

/**
 * Placeholder schema until M1 抓包确认真实形状。
 * 修改本文件必须同步更新 docs/api/health.md 和 fixtures/responses/health/.
 */
export const HealthResponse = z.object({
  ok: z.boolean(),
  uptime: z.number().nonnegative().optional(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
