import type { Db } from "@socialmonitor/db";

export interface FakeSqlCall {
  text: string;
  values: unknown[];
}

export interface FakeSql {
  db: Db;
  calls: FakeSqlCall[];
  /** Queue a canned result for the next query whose text matches `match`. */
  when(match: RegExp, rows: Record<string, unknown>[]): void;
}

/**
 * Minimal stand-in for the postgres.js tagged-template client. Adapters only
 * need it for credential lookup, budget bookkeeping, event writes and context
 * queries — all of which tolerate empty results. Anything not explicitly
 * stubbed returns [], which is the "nothing recorded yet" state.
 */
export function fakeSql(): FakeSql {
  const calls: FakeSqlCall[] = [];
  const stubs: { match: RegExp; rows: Record<string, unknown>[] }[] = [];

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    const stub = stubs.find((s) => s.match.test(text));
    return Promise.resolve(stub ? stub.rows : []);
  }) as unknown as Db & { json: (v: unknown) => unknown };

  (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;

  return {
    db: sql as unknown as Db,
    calls,
    when(match, rows) {
      stubs.push({ match, rows });
    },
  };
}

export interface StubbedResponse {
  status?: number;
  body: unknown;
}

/**
 * Replace global fetch with a scripted responder. Each entry is matched
 * against the request URL in order; a matched entry is consumed so successive
 * pages can return different payloads.
 */
export function stubFetch(script: { match: RegExp; response: StubbedResponse }[]): {
  urls: string[];
  restore: () => void;
} {
  const urls: string[] = [];
  const queue = [...script];
  const original = globalThis.fetch;

  // `input` is typed loosely on purpose: this package compiles without DOM
  // lib, so RequestInfo/Request are not in scope.
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === "string" ? input : String(input);
    urls.push(url);
    const idx = queue.findIndex((s) => s.match.test(url));
    if (idx === -1) {
      throw new Error(`unstubbed fetch: ${url}`);
    }
    const { response } = queue.splice(idx, 1)[0]!;
    const status = response.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => response.body,
      text: async () => JSON.stringify(response.body),
    } as Response;
  }) as typeof fetch;

  return { urls, restore: () => { globalThis.fetch = original; } };
}
