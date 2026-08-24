/**
 * One-time helper: generate the GramJS StringSession for the DEDICATED
 * Telegram account (D8 — never your personal number).
 *
 * 1. Create api_id + api_hash at https://my.telegram.org (logged in as the
 *    dedicated account)
 * 2. Run:  TELEGRAM_MTPROTO_API_ID=... TELEGRAM_MTPROTO_API_HASH=... \
 *          pnpm --filter @socialmonitor/pipeline exec tsx ../../scripts/telegram-session.ts
 * 3. Enter the phone number + login code when prompted
 * 4. Paste the printed session string into TELEGRAM_MTPROTO_SESSION
 *    (or the Connections page)
 */
import readline from "node:readline/promises";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const apiId = Number(process.env.TELEGRAM_MTPROTO_API_ID);
const apiHash = process.env.TELEGRAM_MTPROTO_API_HASH;
if (!apiId || !apiHash) {
  console.error("Set TELEGRAM_MTPROTO_API_ID and TELEGRAM_MTPROTO_API_HASH first.");
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 3 });

await client.start({
  phoneNumber: () => rl.question("Phone number (dedicated account): "),
  password: () => rl.question("2FA password (if set): "),
  phoneCode: () => rl.question("Login code: "),
  onError: (err) => console.error(err),
});

console.log("\nTELEGRAM_MTPROTO_SESSION=");
console.log(client.session.save());
await client.disconnect();
rl.close();
process.exit(0);
