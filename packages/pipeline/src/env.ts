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
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
