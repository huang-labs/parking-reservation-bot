import type { Env } from "./env";

export type Button =
  | { text: string; callback_data: string }
  | { text: string; web_app: { url: string } }
  | { text: string; url: string };
export type Keyboard = Button[][];

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function tg<T = unknown>(env: Env, method: string, params: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const json = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!json.ok) console.error(JSON.stringify({ event: "telegram_error", method, description: json.description }));
  return json.result;
}

export function send(
  env: Env,
  chatId: number,
  text: string,
  opts: { keyboard?: Keyboard; silent?: boolean } = {},
) {
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_notification: opts.silent ?? false,
    link_preview_options: { is_disabled: true },
    ...(opts.keyboard ? { reply_markup: { inline_keyboard: opts.keyboard } } : {}),
  });
}

/** Admin alert, de-duplicated per `kind` for 30 minutes via the config table. */
export async function alertAdmin(env: Env, kind: string, text: string) {
  const key = `alert_at:${kind}`;
  const now = Date.now();
  const row = await env.DB.prepare("SELECT value FROM config WHERE key = ?").bind(key).first<{ value: string }>();
  if (row && now - Number(row.value) < 30 * 60_000) return;
  await env.DB.prepare("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, String(now))
    .run();
  console.error(JSON.stringify({ event: "admin_alert", kind, text }));
  const admin = Number(env.ADMIN_TG_USER_ID);
  if (admin) await send(env, admin, `🚨 <b>${esc(kind)}</b>\n${text}`);
}
