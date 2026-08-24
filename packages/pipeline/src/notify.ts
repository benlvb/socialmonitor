/**
 * Channel-agnostic notifier (D19). Telegram implementation in v1; Slack later.
 * Template-first: missing credentials degrade to console logging, never throw.
 */
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

function buildNotifier(): Notifier {
  const token = process.env.TELEGRAM_NOTIFY_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_NOTIFY_CHAT_ID;
  if (token && chatId) return new TelegramNotifier(token, chatId);
  return new ConsoleNotifier();
}

let notifier: Notifier | null = null;

export async function notify(text: string): Promise<void> {
  notifier ??= buildNotifier();
  try {
    await notifier.send(`socialmonitor\n${text}`);
  } catch (err) {
    console.error("[notify] failed", err);
  }
}
