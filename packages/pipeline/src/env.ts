import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Local development: load the repo-root `.env` the README tells you to create.
 * Imported FIRST by the worker entry so modules that read env at import time
 * (model ids, the global cap) see it. Variables already in the environment win,
 * and a missing file is simply skipped — in the Railway image there is no
 * `.env` (dockerignored) and every value comes from the platform.
 */
const rootEnv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env");
try {
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
} catch (err) {
  // Unreadable or vanished file: the worker must still start (template-first —
  // an unconfigured DATABASE_URL is a state, not a crash) — but say why the
  // file it found did not load, or "idle (unconfigured)" is a mystery.
  console.warn(`[env] found ${rootEnv} but could not load it: ${String(err)}`);
}
