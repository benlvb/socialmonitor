/**
 * Channel-agnostic notifier (D19). Telegram implementation in v1; Slack later.
 * Vault-aware (audit #7): env vars are the bootstrap path; a telegram_notify
 * row saved on the Connections page also works, no deploy needed.
 * Missing credentials degrade to console logging, never throw.
 */
import type { Db } from "@socialmonitor/db";

export interface Notifier {
  send(text: string): Promise<void>;
}

class TelegramNotifier implements Notifier {
  constructor(
    private readonly token: string,
    private readonly chatId: string,
  ) {}

  async send(text: string): Promise<void> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text: text.slice(0, 4000) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      console.error(`[notify] telegram sendMessage failed: ${res.status} ${await res.text()}`);
    }
  }
}

class ConsoleNotifier implements Notifier {
  async send(text: string): Promise<void> {
    console.log(`[notify:console] ${text}`);
  }
}

let cached: { key: string; notifier: Notifier } | null = null;

async function resolveNotifier(sql: Db | null): Promise<Notifier> {
  let token = process.env.TELEGRAM_NOTIFY_BOT_TOKEN;
  let chatId = process.env.TELEGRAM_NOTIFY_CHAT_ID;

  if ((!token || !chatId) && sql) {
    try {
      // Single-operator: first configured telegram_notify credential wins.
      const rows = await sql`
        select vs.decrypted_secret
        from source_credentials sc
        join vault.decrypted_secrets vs on vs.id = sc.vault_secret_id
        where sc.source = 'telegram_notify' and sc.vault_secret_id is not null
        limit 1`;
      if (rows[0]?.decrypted_secret) {
        const secret = JSON.parse(rows[0].decrypted_secret as string) as Record<string, string>;
        token = token || secret.TELEGRAM_NOTIFY_BOT_TOKEN;
        chatId = chatId || secret.TELEGRAM_NOTIFY_CHAT_ID;
      }
    } catch (err) {
      console.warn("[notify] vault lookup failed, using console", err);
    }
  }

  if (token && chatId) {
    const key = `${token.slice(-8)}:${chatId}`;
    if (cached?.key !== key) cached = { key, notifier: new TelegramNotifier(token, chatId) };
    return cached.notifier;
  }
  return new ConsoleNotifier();
}

export async function notify(text: string, sql?: Db | null): Promise<void> {
  try {
    const notifier = await resolveNotifier(sql ?? null);
    await notifier.send(`socialmonitor\n${text}`);
  } catch (err) {
    console.error("[notify] failed", err);
  }
}
