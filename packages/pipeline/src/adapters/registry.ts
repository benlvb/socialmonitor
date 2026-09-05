import type { Db } from "@socialmonitor/db";
import type { Source } from "@socialmonitor/shared";
import type { SourceAdapter } from "./types";
import { xAdapter } from "./x";
import { redditAdapter } from "./reddit";
import { youtubeAdapter } from "./youtube";
import { telegramAdapter } from "./telegram";
import { discordAdapter } from "./discord";
import { appstoreAdapter } from "./appstore";

const registry = new Map<Source, SourceAdapter>([
  ["x", xAdapter],
  ["reddit", redditAdapter],
  ["youtube", youtubeAdapter],
  ["telegram", telegramAdapter],
  ["discord", discordAdapter],
  ["appstore", appstoreAdapter],
]);

export function getAdapter(source: Source): SourceAdapter {
  const a = registry.get(source);
  if (!a) throw new Error(`no adapter registered for source ${source}`);
  return a;
}

export function registerAdapter(adapter: SourceAdapter): void {
  registry.set(adapter.source, adapter);
}

export { resolveCredentials } from "./credentials";

export type { Db };
