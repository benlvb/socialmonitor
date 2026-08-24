import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fixture replay (D22): FIXTURE_MODE=1 makes each adapter return these
 * payloads through its REAL parse -> store -> classify path. First run per
 * stream only (cursor set afterwards), so re-runs are quiet like production.
 */
export function fixtureMode(): boolean {
  return process.env.FIXTURE_MODE === "1";
}

const here = path.dirname(fileURLToPath(import.meta.url));

export async function loadFixture<T>(name: string): Promise<T> {
  const file = path.join(here, "..", "..", "fixtures", `${name}.json`);
  return JSON.parse(await readFile(file, "utf8")) as T;
}
