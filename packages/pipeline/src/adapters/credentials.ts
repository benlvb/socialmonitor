import type { Db } from "@socialmonitor/db";
import type { Integration } from "@socialmonitor/shared";

/**
 * Credential resolution (D22, SPEC section 10): the connections page (Vault)
 * is the runtime path and takes precedence; env vars are the bootstrap path.
 * Returns null when unconfigured — callers must skip cleanly, never throw.
 */

export const ENV_KEYS: Record<Integration, string[]> = {
  x_scraper: ["TWITTERAPI_IO_KEY"],
  reddit: ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET", "REDDIT_USERNAME", "REDDIT_PASSWORD"],
  youtube: ["YOUTUBE_API_KEY"],
  telegram_mtproto: ["TELEGRAM_MTPROTO_API_ID", "TELEGRAM_MTPROTO_API_HASH", "TELEGRAM_MTPROTO_SESSION"],
  discord_bot: ["DISCORD_BOT_TOKEN"],
  google_play: ["GOOGLE_SERVICE_ACCOUNT_JSON"],
  anthropic: ["ANTHROPIC_API_KEY"],
  telegram_notify: ["TELEGRAM_NOTIFY_BOT_TOKEN", "TELEGRAM_NOTIFY_CHAT_ID"],
};

export type Credentials = Record<string, string>;

export async function resolveCredentials(
  sql: Db | null,
  ownerId: string,
  integration: Integration,
): Promise<Credentials | null> {
  // 1. Vault-backed row (secret payload is a JSON object of key -> value)
  if (sql) {
    try {
      const rows = await sql`
        select sc.config, vs.decrypted_secret
        from source_credentials sc
        left join vault.decrypted_secrets vs on vs.id = sc.vault_secret_id
        where sc.owner_id = ${ownerId} and sc.source = ${integration}
          and sc.vault_secret_id is not null
        limit 1`;
      const row = rows[0];
      if (row?.decrypted_secret) {
        const secret = JSON.parse(row.decrypted_secret as string) as Credentials;
        return { ...((row.config as Credentials) ?? {}), ...secret };
      }
    } catch (err) {
      // Vault may be absent locally; a real failure must at least be visible.
      console.warn(`[credentials] vault lookup failed for ${integration}; falling back to env`, err);
    }
  }

  // 2. Env fallback: all keys for the integration must be present
  const keys = ENV_KEYS[integration];
  const out: Credentials = {};
  for (const k of keys) {
    const v = process.env[k];
    if (!v) return null;
    out[k] = v;
  }
  return out;
}
