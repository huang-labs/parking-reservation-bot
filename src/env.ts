import type { AccountAgent } from "./do/account";
import type { LotDateMonitor } from "./do/monitor";
import type { ScoutSession } from "./do/scout";

export interface Env {
  DB: D1Database;
  SCOUT: DurableObjectNamespace<ScoutSession>;
  MONITOR: DurableObjectNamespace<LotDateMonitor>;
  ACCOUNT: DurableObjectNamespace<AccountAgent>;
  PUBLIC_URL: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  CREDS_ENC_KEY: string;
  SCOUT_EMAIL: string;
  SCOUT_PASSWORD: string;
  ADMIN_TG_USER_ID: string;
}

export const scout = (env: Env) => env.SCOUT.get(env.SCOUT.idFromName("scout"));
export const monitor = (env: Env, lot: string, date: string) => env.MONITOR.get(env.MONITOR.idFromName(`${lot}:${date}`));
export const account = (env: Env, tgUserId: number) => env.ACCOUNT.get(env.ACCOUNT.idFromName(String(tgUserId)));
