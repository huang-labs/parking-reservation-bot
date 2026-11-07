import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    test: {
      projects: [
        { test: { name: "node", include: ["test/node/**/*.test.ts"], environment: "node" } },
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                bindings: {
                  TEST_MIGRATIONS: migrations,
                  PUBLIC_URL: "https://bot.test",
                  TELEGRAM_BOT_TOKEN: "123:test-token",
                  TELEGRAM_WEBHOOK_SECRET: "hook-secret",
                  CREDS_ENC_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
                  SCOUT_EMAIL: "scout@test",
                  SCOUT_PASSWORD: "scout-pw",
                  ADMIN_TG_USER_ID: "1",
                },
              },
            }),
          ],
          test: { name: "workers", include: ["test/*.test.ts"], setupFiles: ["./test/apply-migrations.ts"] },
        },
      ],
    },
  };
});
