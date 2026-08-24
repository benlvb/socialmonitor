import { createDb } from "@socialmonitor/db";

/**
 * Worker entry (P0 skeleton — queue consumer lands in P1).
 * Template-first (D22): a missing DATABASE_URL is a valid state, not a crash.
 */
async function main(): Promise<void> {
  const fixtureMode = process.env.FIXTURE_MODE === "1";
  const db = createDb();

  console.log(`[worker] socialmonitor pipeline starting (fixture_mode=${fixtureMode})`);
  if (!db) {
    console.log("[worker] DATABASE_URL not set — nothing to consume; idling. Configure Supabase to activate.");
    // Stay alive so Railway doesn't crash-loop while unconfigured.
    setInterval(() => console.log("[worker] idle (unconfigured)"), 5 * 60 * 1000);
    return;
  }

  console.log("[worker] connected; queue consumer arrives in P1");
  await db.end();
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});
