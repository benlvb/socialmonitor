import "./env";
import { createDb } from "@socialmonitor/db";
import { archiveJob, checkSessionAffinity, deleteJob, readJobs, shouldArchive } from "./queue";
import { runJob } from "./runner";
import { logEvent } from "./events";
import { notify } from "./notify";

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

  const affinity = await checkSessionAffinity(db);
  if (!affinity.ok) {
    await logEvent(db, {
      level: "error",
      kind: "pooler_misconfigured",
      message: `advisory-lock session affinity check FAILED: ${affinity.detail}`,
    });
    console.error(`[worker] ${affinity.detail}`);
  } else {
    console.log(`[worker] ${affinity.detail}`);
  }

  // Global ops watch: monitor-less error events (e.g. partition_maintenance_failed
  // raised inside pg_cron) are invisible to the UI since events went owner-scoped
  // (audit #26c) - page the operator from here instead.
  let lastGlobalCheck = new Date();
  setInterval(() => {
    void (async () => {
      try {
        const rows = await db`
          select kind, message from pipeline_events
          where monitor_id is null and level = 'error' and created_at > ${lastGlobalCheck}
          order by created_at asc limit 10`;
        lastGlobalCheck = new Date();
        for (const r of rows) await notify(`${r.kind}\n${r.message}`, db);
      } catch (err) {
        console.error("[worker] global event watch failed", err);
      }
    })();
  }, 5 * 60 * 1000).unref();

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
      // Every job is fully guarded: an exception from archiveJob/logEvent used
      // to escape Promise.all and kill the process, and Railway's restart cap
      // could then stop the worker permanently on a DB blip (audit #21).
      jobs.map(async (job) => {
       try {
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
       } catch (outer) {
        console.error(`[worker] job handling failed for ${job.msgId}`, outer);
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
