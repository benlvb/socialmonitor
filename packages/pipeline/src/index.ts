import { createDb } from "@socialmonitor/db";
import { archiveJob, deleteJob, readJobs, shouldArchive } from "./queue.js";
import { runJob } from "./runner.js";
import { logEvent } from "./events.js";

const POLL_MS = 10_000;
const CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 2));

let shuttingDown = false;

/**
 * Worker main loop: consume pgmq jobs produced by pg_cron (SPEC section 1).
 * Template-first (D22): a missing DATABASE_URL is a valid state, not a crash.
 */
async function main(): Promise<void> {
  const fixtureMode = process.env.FIXTURE_MODE === "1";
  const db = createDb();
  console.log(
    `[worker] socialmonitor pipeline starting (fixture_mode=${fixtureMode}, concurrency=${CONCURRENCY})`,
  );

  if (!db) {
    console.log(
      "[worker] DATABASE_URL not set — idling. Configure Supabase to activate the pipeline.",
    );
    setInterval(() => console.log("[worker] idle (unconfigured)"), 5 * 60 * 1000);
    return;
  }

  process.on("SIGTERM", () => (shuttingDown = true));
  process.on("SIGINT", () => (shuttingDown = true));

  while (!shuttingDown) {
    let jobs;
    try {
      jobs = await readJobs(db, CONCURRENCY);
    } catch (err) {
      console.error("[worker] queue read failed, retrying", err);
      await sleep(POLL_MS);
      continue;
    }

    if (jobs.length === 0) {
      await sleep(POLL_MS);
      continue;
    }

    await Promise.all(
      jobs.map(async (job) => {
        if (shouldArchive(job)) {
          await archiveJob(db, job.msgId);
          if (job.payload === null) {
            await logEvent(db, {
              level: "warn",
              kind: "job_malformed",
              message: `archived malformed queue message ${job.msgId}`,
            });
          } else {
            await logEvent(db, {
              monitorId: job.payload.monitorId,
              source: job.payload.source,
              level: "error",
              kind: "job_poisoned",
              message: `job archived after ${job.readCt} attempts: ${JSON.stringify(job.payload)}`,
            });
          }
          return;
        }
        try {
          await runJob(db, job.payload!);
          await deleteJob(db, job.msgId);
        } catch (err) {
          // Leave the message; visibility timeout re-delivers it. Poison-pill
          // protection above archives after repeated failures.
          console.error(`[worker] job ${job.msgId} failed`, err);
        }
      }),
    );
  }

  console.log("[worker] shutting down");
  await db.end({ timeout: 5 });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});
