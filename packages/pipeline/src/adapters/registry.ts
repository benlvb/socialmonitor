import type { Db } from "@socialmonitor/db";
import type { Source } from "@socialmonitor/shared";
import type { SourceAdapter } from "./types.js";
import { xAdapter } from "./x.js";
import { redditAdapter } from "./reddit.js";
import { youtubeAdapter } from "./youtube.js";
import { telegramAdapter } from "./telegram.js";
import { discordAdapter } from "./discord.js";

const registry = new Map<Source, SourceAdapter>([
  ["x", xAdapter],
  ["reddit", redditAdapter],
  ["youtube", youtubeAdapter],
  ["telegram", telegramAdapter],
  ["discord", discordAdapter],
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
