import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PerItemError,
  SystemicError,
  TransientError,
  parseMonitorConfig,
  type RawItem,
} from "@socialmonitor/shared";

/**
 * The cursor contract (SPEC §2/§9) is the invariant that protects against the
 * only unrecoverable failure this system has: acknowledging data as read that
 * was never stored. Both audits found four independent ways to break it, so it
 * is asserted here directly rather than inferred from adapter parse output.
 */

const repos = vi.hoisted(() => ({
  getStreamState: vi.fn(),
  insertRawItems: vi.fn(),
  markStreamSuccess: vi.fn(),
  markStreamFailure: vi.fn(),
  getMonitor: vi.fn(),
  getTargets: vi.fn(),
  getDueMetricsRefs: vi.fn(),
  insertMetricsHistory: vi.fn(),
}));
const events = vi.hoisted(() => ({ logEvent: vi.fn() }));

vi.mock("../src/db/repos", () => repos);
vi.mock("../src/events", () => events);

const { runFetchStream } = await import("../src/runner");
import type { SourceAdapter } from "../src/adapters/types";
import type { MonitorRow } from "../src/db/repos";

const monitor: MonitorRow = {
  id: "00000000-0000-0000-0000-000000000001",
  owner_id: "00000000-0000-0000-0000-000000000002",
  name: "contract-monitor",
  status: "active",
  config: parseMonitorConfig({}),
};
const stream = { stream: "search/t1" };
const sql = {} as never;

function adapterThat(behaviour: Partial<SourceAdapter>): SourceAdapter {
  return {
    source: "x",
    status: async () => ({ configured: true }),
    testConnection: async () => ({ ok: true, message: "" }),
    streams: () => [stream],
    fetch: async () => ({ items: [], nextCursor: null }),
    ...behaviour,
  } as SourceAdapter;
}

const item = (id: string): RawItem => ({
  monitorId: monitor.id,
  source: "x",
  externalId: id,
  stream: stream.stream,
  url: `https://x.com/i/status/${id}`,
  authorId: "a",
  authorHandle: "a",
  authorName: "a",
  authorFollowers: 1,
  content: "hello world content",
  postedAt: new Date("2026-08-20T10:00:00Z"),
  parentExternalId: "",
  context: {},
  metrics: {},
  impressions: null,
  engagement: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  repos.getStreamState.mockResolvedValue({
    cursor: "1000",
    cursor_meta: { pending_until: 900 },
    rows_total: 5,
    consecutive_failures: 0,
    breaker_tripped_at: null,
    last_run_at: null,
    last_success_at: null,
  });
  repos.insertRawItems.mockImplementation(async (_s: unknown, items: RawItem[]) => items.length);
  repos.markStreamFailure.mockResolvedValue(false);
});

describe("cursor contract — success path", () => {
  it("advances the cursor and persists cursor_meta only on success", async () => {
    const adapter = adapterThat({
      fetch: async () => ({
        items: [item("1"), item("2")],
        nextCursor: "2000",
        cursorMeta: { pending_until: null },
      }),
    });
    await runFetchStream(sql, monitor, adapter, stream);

    expect(repos.insertRawItems).toHaveBeenCalledOnce();
    expect(repos.markStreamSuccess).toHaveBeenCalledWith(
      sql, monitor.id, "x", stream.stream, "2000", 2, { pending_until: null },
    );
    expect(repos.markStreamFailure).not.toHaveBeenCalled();
  });

  it("passes the stored cursor AND cursor_meta into the adapter", async () => {
    const fetch = vi.fn(async () => ({ items: [], nextCursor: null }));
    await runFetchStream(sql, monitor, adapterThat({ fetch }), stream);
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: "1000", cursorMeta: { pending_until: 900 } }),
    );
  });

  it("a null nextCursor is a HOLD, not a blank — it never overwrites the stored cursor", async () => {
    const adapter = adapterThat({
      fetch: async () => ({ items: [item("1")], nextCursor: null }),
    });
    await runFetchStream(sql, monitor, adapter, stream);
    // markStreamSuccess coalesces null onto the existing cursor; the contract is
    // that an incomplete window still stores its items but does not move on.
    const [, , , , cursorArg] = repos.markStreamSuccess.mock.calls[0]!;
    expect(cursorArg).toBeNull();
    expect(repos.insertRawItems).toHaveBeenCalledOnce();
  });

  it("reports dropped per-item failures without failing the run", async () => {
    const adapter = adapterThat({
      fetch: async () => ({ items: [item("1")], nextCursor: "2000", droppedCount: 3 }),
    });
    await runFetchStream(sql, monitor, adapter, stream);
    expect(repos.markStreamSuccess).toHaveBeenCalledOnce();
    expect(events.logEvent).toHaveBeenCalledWith(
      sql, expect.objectContaining({ kind: "items_dropped", level: "warn" }),
    );
  });
});

describe("cursor contract — failure paths", () => {
  it("TransientError holds the cursor and does NOT touch the breaker", async () => {
    const adapter = adapterThat({
      fetch: async () => {
        throw new TransientError("503 from upstream");
      },
    });
    await runFetchStream(sql, monitor, adapter, stream);

    expect(repos.markStreamSuccess).not.toHaveBeenCalled();
    expect(repos.markStreamFailure).toHaveBeenCalledWith(
      sql, monitor.id, "x", stream.stream, "transient",
    );
  });

  it("a PerItemError that escapes the adapter is treated as a held batch, not systemic", async () => {
    const adapter = adapterThat({
      fetch: async () => {
        throw new PerItemError("bad utf-8", "abc");
      },
    });
    await runFetchStream(sql, monitor, adapter, stream);

    expect(repos.markStreamSuccess).not.toHaveBeenCalled();
    expect(repos.markStreamFailure).toHaveBeenCalledWith(
      sql, monitor.id, "x", stream.stream, "transient",
    );
  });

  it("SystemicError increments the breaker and holds the cursor", async () => {
    const adapter = adapterThat({
      fetch: async () => {
        throw new SystemicError("401 revoked key");
      },
    });
    await runFetchStream(sql, monitor, adapter, stream);

    expect(repos.markStreamSuccess).not.toHaveBeenCalled();
    expect(repos.markStreamFailure).toHaveBeenCalledWith(
      sql, monitor.id, "x", stream.stream, "systemic",
    );
    expect(events.logEvent).toHaveBeenCalledWith(
      sql, expect.objectContaining({ kind: "run_failed" }),
    );
  });

  it("an untyped error is treated as systemic, never as success", async () => {
    const adapter = adapterThat({
      fetch: async () => {
        throw new TypeError("undefined is not a function");
      },
    });
    await runFetchStream(sql, monitor, adapter, stream);
    expect(repos.markStreamSuccess).not.toHaveBeenCalled();
    expect(repos.markStreamFailure).toHaveBeenCalledWith(
      sql, monitor.id, "x", stream.stream, "systemic",
    );
  });

  it("escalates to breaker_tripped (error level) when the threshold is reached", async () => {
    repos.markStreamFailure.mockResolvedValue(true);
    const adapter = adapterThat({
      fetch: async () => {
        throw new SystemicError("channel deleted");
      },
    });
    await runFetchStream(sql, monitor, adapter, stream);
    expect(events.logEvent).toHaveBeenCalledWith(
      sql, expect.objectContaining({ kind: "breaker_tripped", level: "error" }),
    );
  });

  it("a tripped breaker skips the stream entirely — no fetch, no cursor write", async () => {
    repos.getStreamState.mockResolvedValue({
      cursor: "1000",
      cursor_meta: {},
      rows_total: 0,
      consecutive_failures: 3,
      breaker_tripped_at: new Date(),
      last_run_at: null,
      last_success_at: null,
    });
    const fetch = vi.fn();
    await runFetchStream(sql, monitor, adapterThat({ fetch }), stream);

    expect(fetch).not.toHaveBeenCalled();
    expect(repos.markStreamSuccess).not.toHaveBeenCalled();
    expect(repos.markStreamFailure).not.toHaveBeenCalled();
  });

  it("items are never stored when the fetch throws (nothing acknowledged)", async () => {
    const adapter = adapterThat({
      fetch: async () => {
        throw new TransientError("died mid-page");
      },
    });
    await runFetchStream(sql, monitor, adapter, stream);
    expect(repos.insertRawItems).not.toHaveBeenCalled();
  });
});
