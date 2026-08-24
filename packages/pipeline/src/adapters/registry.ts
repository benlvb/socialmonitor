import type { Db } from "@socialmonitor/db";
import type { Source } from "@socialmonitor/shared";
import type { MonitorRow, TargetRow } from "../db/repos.js";
import type { SourceAdapter, StreamDef } from "./types.js";

/**
 * Placeholder adapter: reports unconfigured and exposes no streams.
 * Real adapters (P2) replace entries in the registry as they are implemented.
 */
function placeholder(source: Source): SourceAdapter {
  return {
    source,
    async status() {
      return { configured: false, detail: "adapter not yet implemented" };
    },
    async testConnection() {
      return { ok: false, message: `${source}: adapter not yet implemented` };
    },
    streams(_monitor: MonitorRow, _targets: TargetRow[]): StreamDef[] {
      return [];
    },
    async fetch() {
      return { items: [], nextCursor: null };
    },
  };
}

const registry = new Map<Source, SourceAdapter>([
  ["x", placeholder("x")],
  ["reddit", placeholder("reddit")],
  ["youtube", placeholder("youtube")],
  ["telegram", placeholder("telegram")],
  ["discord", placeholder("discord")],
]);

export function getAdapter(source: Source): SourceAdapter {
  const a = registry.get(source);
  if (!a) throw new Error(`no adapter registered for source ${source}`);
  return a;
}

export function registerAdapter(adapter: SourceAdapter): void {
  registry.set(adapter.source, adapter);
}

export type { Db };
