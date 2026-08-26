import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseMonitorConfig } from "@socialmonitor/shared";
import { fakeSql } from "./helpers/fake-sql";
import type { MonitorRow, TargetRow } from "../src/db/repos";

/**
 * Telegram's MTProto client is mocked so the ADAPTER's cursor semantics are
 * under test: GramJS returns newest-first by default, which silently lost the
 * middle of any busy window, and a first sync must not crawl the channel's
 * entire history.
 */
const gram = vi.hoisted(() => ({
  getMessages: vi.fn(),
  connect: vi.fn(async () => undefined),
}));

vi.mock("telegram", () => ({
  TelegramClient: class {
    connect = gram.connect;
    getMessages = gram.getMessages;
    getMe = async () => ({ username: "monitorbot" });
  },
}));
vi.mock("telegram/sessions/index.js", () => ({
  StringSession: class {
    constructor(_s: string) {}
  },
}));

const { telegramAdapter } = await import("../src/adapters/telegram");

const monitor: MonitorRow = {
  id: "00000000-0000-0000-0000-000000000001",
  owner_id: "00000000-0000-0000-0000-000000000002",
  name: "tg-monitor",
  status: "active",
  config: parseMonitorConfig({}),
};
const target: TargetRow = {
  id: "t1", monitor_id: monitor.id, source: "telegram",
  kind: "channel", value: "acmewidgetchat", enabled: true, config: {},
};
const stream = { stream: "channel/t1", target };

const tgMsg = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  message: `message ${id} body long enough to be real signal`,
  date: Math.floor(Date.UTC(2026, 7, 20, 10) / 1000) + id,
  views: 100,
  forwards: 1,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TELEGRAM_MTPROTO_API_ID", "12345");
  vi.stubEnv("TELEGRAM_MTPROTO_API_HASH", "hash");
  vi.stubEnv("TELEGRAM_MTPROTO_SESSION", "session-string");
});

describe("Telegram cursor semantics", () => {
  it("first sync probes the newest id and fetches NOTHING (no history crawl)", async () => {
    gram.getMessages.mockResolvedValueOnce([tgMsg(500)]);
    const sql = fakeSql();
    const r = await telegramAdapter.fetch({
      sql: sql.db, monitor, stream, cursor: null, cursorMeta: {},
    });
    expect(gram.getMessages).toHaveBeenCalledWith("acmewidgetchat", { limit: 1 });
    expect(r.items).toEqual([]);
    expect(r.nextCursor).toBe("500");
  });

  it("pages ASCENDING from the cursor — never the newest N", async () => {
    gram.getMessages.mockResolvedValueOnce([tgMsg(501), tgMsg(502), tgMsg(503)]);
    const sql = fakeSql();
    const r = await telegramAdapter.fetch({
      sql: sql.db, monitor, stream, cursor: "500", cursorMeta: {},
    });
    // The regression: without reverse:true GramJS returns the newest 100 and a
    // busy window loses everything between the cursor and that page.
    expect(gram.getMessages).toHaveBeenCalledWith(
      "acmewidgetchat",
      expect.objectContaining({ minId: 500, reverse: true }),
    );
    expect(r.items).toHaveLength(3);
    expect(r.nextCursor).toBe("503");
  });

  it("attributes messages to the real sender, not the channel", async () => {
    gram.getMessages.mockResolvedValueOnce([
      tgMsg(510, { senderId: 777, sender: { username: "real_user", firstName: "Real" } }),
      tgMsg(511, { senderId: 888 }), // no username -> stable synthetic handle
    ]);
    const sql = fakeSql();
    const r = await telegramAdapter.fetch({
      sql: sql.db, monitor, stream, cursor: "500", cursorMeta: {},
    });
    // Using the channel name for everyone collapsed author_count — the ranking
    // metric — to 1 for every monitored group.
    expect(r.items[0]!.authorHandle).toBe("real_user");
    expect(r.items[1]!.authorHandle).toBe("tg:888");
    expect(new Set(r.items.map((i) => i.authorHandle)).size).toBe(2);
  });

  it("skips service messages per-item without moving the cursor backwards", async () => {
    gram.getMessages.mockResolvedValueOnce([
      tgMsg(520),
      { id: 521, date: 0, message: "" }, // service message: no text, no date
    ]);
    const sql = fakeSql();
    const r = await telegramAdapter.fetch({
      sql: sql.db, monitor, stream, cursor: "500", cursorMeta: {},
    });
    expect(r.items).toHaveLength(1);
    expect(r.droppedCount).toBe(1);
    expect(Number(r.nextCursor)).toBeGreaterThanOrEqual(521); // still advances past it
  });
});
