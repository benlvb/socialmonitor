"use server";

import { revalidatePath } from "next/cache";
import { createDb } from "@socialmonitor/db";
import { INTEGRATIONS, type Integration, type Source } from "@socialmonitor/shared";
import { requireUser } from "../../../lib/supabase/server";

export interface ConnectionState {
  error?: string;
  message?: string;
}

const INTEGRATION_TO_SOURCE: Partial<Record<Integration, Source>> = {
  x_scraper: "x",
  reddit: "reddit",
  youtube: "youtube",
  telegram_mtproto: "telegram",
  discord_bot: "discord",
};

function asIntegration(raw: string): Integration | null {
  return (INTEGRATIONS as readonly string[]).includes(raw) ? (raw as Integration) : null;
}

/**
 * Store secret material in Supabase Vault and reference it from
 * source_credentials (SPEC section 3). Vault is service-path only — the
 * postgres client with service credentials does the write, scoped to the
 * session user's ownership.
 */
export async function saveCredentials(
  _prev: ConnectionState,
  formData: FormData,
): Promise<ConnectionState> {
  const { user } = await requireUser();
  if (!user) return { error: "Not signed in." };
  const integration = asIntegration(String(formData.get("integration") ?? ""));
  if (!integration) return { error: "Unknown integration." };

  const secret: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key === "integration" || typeof value !== "string") continue;
    if (value.trim()) secret[key] = value.trim();
  }
  if (Object.keys(secret).length === 0) return { error: "No values provided." };

  const sql = createDb();
  if (!sql) return { error: "DATABASE_URL not configured on the web app." };
  try {
    const existing = await sql`
      select id, vault_secret_id from source_credentials
      where owner_id = ${user.id} and source = ${integration} and label = 'default'`;
    const payload = JSON.stringify(secret);
    if (existing[0]?.vault_secret_id) {
      await sql`select vault.update_secret(${existing[0].vault_secret_id}, ${payload})`;
      await sql`
        update source_credentials set status = 'unconfigured', last_checked_at = null
        where id = ${existing[0].id}`;
    } else {
      const created = await sql`select vault.create_secret(${payload}) as id`;
      await sql`
        insert into source_credentials (owner_id, source, label, vault_secret_id, config, status)
        values (${user.id}, ${integration}, 'default', ${created[0]!.id}, ${"{}"}, 'unconfigured')
        on conflict (owner_id, source, label)
        do update set vault_secret_id = ${created[0]!.id}, status = 'unconfigured', last_checked_at = null`;
    }
  } catch (err) {
    return { error: `Vault write failed: ${String(err)}` };
  } finally {
    await sql.end({ timeout: 3 });
  }
  revalidatePath("/connections");
  return { message: "Saved. Run a test to verify, then the pipeline uses it on its next tick." };
}

export async function testIntegration(
  _prev: ConnectionState,
  formData: FormData,
): Promise<ConnectionState> {
  const { user } = await requireUser();
  if (!user) return { error: "Not signed in." };
  const integration = asIntegration(String(formData.get("integration") ?? ""));
  if (!integration) return { error: "Unknown integration." };

  const sql = createDb();
  let result: { ok: boolean; message: string };
  try {
    const source = INTEGRATION_TO_SOURCE[integration];
    if (source) {
      const { getAdapter } = await import("@socialmonitor/pipeline/adapters");
      if (!sql) return { error: "DATABASE_URL not configured on the web app." };
      result = await getAdapter(source).testConnection(sql, user.id);
    } else if (integration === "anthropic") {
      const key = process.env.ANTHROPIC_API_KEY;
      result = key
        ? { ok: true, message: "ANTHROPIC_API_KEY present" }
        : { ok: false, message: "ANTHROPIC_API_KEY not set" };
    } else {
      // telegram_notify
      const token = process.env.TELEGRAM_NOTIFY_BOT_TOKEN;
      if (!token) {
        result = { ok: false, message: "TELEGRAM_NOTIFY_BOT_TOKEN not set" };
      } else {
        const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
          signal: AbortSignal.timeout(15_000),
        });
        const body = (await res.json()) as { ok?: boolean; result?: { username?: string } };
        result = body.ok
          ? { ok: true, message: `bot @${body.result?.username ?? "?"} reachable` }
          : { ok: false, message: "getMe failed — check the token" };
      }
    }

    if (sql) {
      await sql`
        insert into source_credentials (owner_id, source, label, config, status, last_checked_at)
        values (${user.id}, ${integration}, 'default', ${"{}"}, ${result.ok ? "ok" : "failing"}, now())
        on conflict (owner_id, source, label)
        do update set status = ${result.ok ? "ok" : "failing"}, last_checked_at = now()`;
    }
  } finally {
    if (sql) await sql.end({ timeout: 3 });
  }

  revalidatePath("/connections");
  return result.ok ? { message: `✓ ${result.message}` } : { error: `✗ ${result.message}` };
}
