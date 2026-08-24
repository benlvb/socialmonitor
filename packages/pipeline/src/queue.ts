import type { Db } from "@socialmonitor/db";
import { JobPayloadSchema, type JobPayload } from "@socialmonitor/shared";

const QUEUE = "pipeline_jobs";
/** Visibility timeout: a crashed worker's job becomes visible again after this. */
const VT_SECONDS = 15 * 60;
const MAX_READS_BEFORE_ARCHIVE = 5;

export interface QueuedJob {
  msgId: bigint;
  readCt: number;
  payload: JobPayload | null; // null = malformed, archive it
}

/**
 * Advisory locks are SESSION-scoped and this code locks and unlocks in separate
 * statements. On Supabase's TRANSACTION pooler those can land on different
 * backends: the lock leaks, pg_try_advisory_lock then always returns false, and
 * withStreamLock reads that as "another worker has it" — every stream stops
 * running while the dashboard looks idle-green (audit #11).
 * Probe once at startup so this fails loudly instead.
 */
export async function checkSessionAffinity(sql: Db): Promise<{ ok: boolean; detail: string }> {
  const reserved = await sql.reserve();
  try {
    const key = 987654321;
    const [locked] = await reserved`select pg_try_advisory_lock(${key}) as ok`;
    if (!locked?.ok) {
      return { ok: false, detail: "probe lock was already held — stale locks from a pooled session?" };
    }
    const [unlocked] = await reserved`select pg_advisory_unlock(${key}) as ok`;
    if (!unlocked?.ok) {
      return {
        ok: false,
        detail:
          "lock and unlock landed on different backends — DATABASE_URL looks like the TRANSACTION pooler (port 6543). Use the SESSION pooler connection string.",
      };
    }
    return { ok: true, detail: "session affinity verified" };
  } finally {
    reserved.release();
  }
}

export async function readJobs(sql: Db, qty: number): Promise<QueuedJob[]> {
  const rows = await sql`
    select msg_id, read_ct, message from pgmq.read(${QUEUE}, ${VT_SECONDS}, ${qty})`;
  return rows.map((r) => {
    const parsed = JobPayloadSchema.safeParse(r.message);
    return {
      msgId: BigInt(r.msg_id as string | number | bigint),
      readCt: Number(r.read_ct),
      payload: parsed.success ? parsed.data : null,
    };
  });
}

export async function deleteJob(sql: Db, msgId: bigint): Promise<void> {
  await sql`select pgmq.delete(${QUEUE}, ${msgId.toString()}::bigint)`;
}

export async function archiveJob(sql: Db, msgId: bigint): Promise<void> {
  await sql`select pgmq.archive(${QUEUE}, ${msgId.toString()}::bigint)`;
}

export function shouldArchive(job: QueuedJob): boolean {
  return job.payload === null || job.readCt > MAX_READS_BEFORE_ARCHIVE;
}

/**
 * Run fn under a session-scoped advisory lock keyed by the stream identity —
 * single-flight per stream across the worker pool. Returns false if the lock
 * was contended (another worker is on it), true if fn ran.
 */
export async function withStreamLock(
  sql: Db,
  key1: string,
  key2: string,
  fn: () => Promise<void>,
): Promise<boolean> {
  const reserved = await sql.reserve();
  try {
    const rows = await reserved`
      select pg_try_advisory_lock(hashtext(${key1}), hashtext(${key2})) as locked`;
    if (!rows[0]?.locked) return false;
    try {
      await fn();
    } finally {
      await reserved`select pg_advisory_unlock(hashtext(${key1}), hashtext(${key2}))`;
    }
    return true;
  } finally {
    reserved.release();
  }
}
