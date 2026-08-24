import { z } from "zod";
import { JOB_KINDS, SOURCES } from "./constants";

/**
 * Queue message. Coarse-grained (monitor, source, kind): the worker expands to
 * concrete streams via the adapter and runs each with its own cursor + advisory lock.
 * kind=weekly_summary uses source "_system".
 */
export const JobPayloadSchema = z.object({
  monitorId: z.string().uuid(),
  source: z.union([z.enum(SOURCES), z.literal("_system")]),
  kind: z.enum(JOB_KINDS),
});
export type JobPayload = z.infer<typeof JobPayloadSchema>;
