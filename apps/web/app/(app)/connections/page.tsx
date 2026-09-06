import { requireUser } from "../../../lib/supabase/server";
import { ConnectionCard } from "./connection-card";

export const dynamic = "force-dynamic";

const CARDS = [
  {
    integration: "anthropic",
    title: "Anthropic (classifier + summaries)",
    description: "Powers classification (Haiku, Batch API) and narratives (Sonnet). The one to plug in first.",
    fields: [{ name: "ANTHROPIC_API_KEY", label: "API key", secret: true }],
    env: ["ANTHROPIC_API_KEY"],
  },
  {
    integration: "x_scraper",
    title: "X / Twitter (hosted scraper)",
    description: "twitterapi.io key — keyword + account streams. Swaps for the official X API later (D5).",
    fields: [{ name: "TWITTERAPI_IO_KEY", label: "twitterapi.io API key", secret: true }],
    env: ["TWITTERAPI_IO_KEY"],
  },
  {
    integration: "reddit",
    title: "Reddit",
    description: "A Reddit 'script' app: client id/secret + the account's username/password.",
    fields: [
      { name: "REDDIT_CLIENT_ID", label: "Client ID", secret: false },
      { name: "REDDIT_CLIENT_SECRET", label: "Client secret", secret: true },
      { name: "REDDIT_USERNAME", label: "Username", secret: false },
      { name: "REDDIT_PASSWORD", label: "Password", secret: true },
    ],
    env: ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET", "REDDIT_USERNAME", "REDDIT_PASSWORD"],
  },
  {
    integration: "youtube",
    title: "YouTube",
    description: "Google Cloud API key with YouTube Data API v3 enabled. Search is quota-budgeted per monitor.",
    fields: [{ name: "YOUTUBE_API_KEY", label: "API key", secret: true }],
    env: ["YOUTUBE_API_KEY"],
  },
  {
    integration: "telegram_mtproto",
    title: "Telegram (MTProto)",
    description: "Dedicated account (D8 — not your personal one): api_id + api_hash from my.telegram.org and a GramJS StringSession.",
    fields: [
      { name: "TELEGRAM_MTPROTO_API_ID", label: "API ID", secret: false },
      { name: "TELEGRAM_MTPROTO_API_HASH", label: "API hash", secret: true },
      { name: "TELEGRAM_MTPROTO_SESSION", label: "StringSession", secret: true },
    ],
    env: ["TELEGRAM_MTPROTO_API_ID", "TELEGRAM_MTPROTO_API_HASH", "TELEGRAM_MTPROTO_SESSION"],
  },
  {
    integration: "discord_bot",
    title: "Discord bot",
    description: "Bot token with the MESSAGE_CONTENT privileged intent enabled — the canary alerts if it's silently lost.",
    fields: [{ name: "DISCORD_BOT_TOKEN", label: "Bot token", secret: true }],
    env: ["DISCORD_BOT_TOKEN"],
  },
  {
    integration: "google_play",
    title: "Google Play (own apps)",
    description:
      "Service-account key JSON, invited in the Play Console with 'View app information'. Official API: your own apps only, reviews from the last ~7 days (D24). `app_public` targets read any app from the public store pages and need no key (D25).",
    fields: [{ name: "GOOGLE_SERVICE_ACCOUNT_JSON", label: "Service account JSON (one line)", secret: true }],
    env: ["GOOGLE_SERVICE_ACCOUNT_JSON"],
  },
  {
    integration: "telegram_notify",
    title: "Telegram alerts (notifier)",
    description: "A fresh bot from BotFather (D19) + the chat/channel id alerts and weekly summaries post to.",
    fields: [
      { name: "TELEGRAM_NOTIFY_BOT_TOKEN", label: "Bot token", secret: true },
      { name: "TELEGRAM_NOTIFY_CHAT_ID", label: "Chat ID", secret: false },
    ],
    env: ["TELEGRAM_NOTIFY_BOT_TOKEN", "TELEGRAM_NOTIFY_CHAT_ID"],
  },
];

export default async function ConnectionsPage() {
  const { supabase } = await requireUser();
  const { data: rows } = await supabase
    .from("source_credentials")
    .select("source, status, last_checked_at, vault_secret_id");

  const byIntegration = new Map((rows ?? []).map((r) => [r.source as string, r]));

  return (
    <>
      <h1>Connections</h1>
      <p className="muted">
        Template-first: every integration below is optional. Plugging one in activates its source on
        the pipeline&apos;s next tick — no deploy. Secrets go to Supabase Vault; env vars work as a
        bootstrap fallback.
      </p>
      {CARDS.map((c) => {
        const row = byIntegration.get(c.integration);
        const envConfigured = c.env.every((k) => Boolean(process.env[k]));
        return (
          <ConnectionCard
            key={c.integration}
            integration={c.integration}
            title={c.title}
            description={c.description}
            fields={c.fields}
            status={(row?.status as string) ?? "unconfigured"}
            lastCheckedAt={(row?.last_checked_at as string) ?? null}
            envConfigured={envConfigured}
          />
        );
      })}
    </>
  );
}
