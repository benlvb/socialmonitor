import postgres from "postgres";

export type Db = postgres.Sql;

/**
 * Worker-side Postgres client (service credentials, bypasses RLS).
 * Returns null when DATABASE_URL is absent — template-first (D22): callers
 * must treat a null DB as "unconfigured", never as an error.
 */
export function createDb(databaseUrl = process.env.DATABASE_URL): Db | null {
  if (!databaseUrl) return null;
  return postgres(databaseUrl, {
    max: Number(process.env.WORKER_CONCURRENCY ?? 2) + 2,
    prepare: false, // Supabase transaction-mode pooler compatibility
    types: {
      // keep timestamptz as JS Date (default) — all comparisons stay tz-aware UTC
    },
  });
}
