# Working in this repository

A Telegram bot that books freed-up Inflow parking at Alta, Brighton and Solitude for the owner and a few invited friends. [README.md](README.md) covers usage, setup and deploy; [docs/DESIGN.md](docs/DESIGN.md) holds the agreed architecture and decisions; [docs/research/](docs/research/) holds verified Inflow API facts. Read DESIGN.md before changing booking, polling or Durable Object behavior.

## Production is the only environment

- Merging to `main` deploys to production (`.github/workflows/ci.yml`): D1 migrations apply, then the Worker deploys. There is no preview or staging. A merged bug acts on real Inflow accounts with real saved cards.
- PRs run `test` (typecheck, tests, review-gate tests, Worker build) and `review` (PR-Agent on GLM 5.3). Review policy (`.pr_agent.toml`, `review.yml`) is read from `main`, so changes to it take effect only after merge.
- Migrations apply before the new code is live: keep each one backward compatible with the currently deployed Worker. Durable Object class changes also need a new `migrations` tag in `wrangler.jsonc`.
- Tests run against fakes (`test/fakes.ts`) in the Workers runtime. The live Inflow API is exercised only through `spike/` on the owner's account, with their go-ahead for that run.

## How the owner works

- **Plan, then build.** New work starts with a design grounded in the code and DESIGN.md: what changes, which files it touches and why, and a short list of open decisions, each with your recommendation. Write code once they say go, and ship it as one PR. A request to "grill" means a round-by-round interview before any plan.
- **Diagnose exactly.** Find the specific cause before reporting a failure: separate Inflow `failReason`s, auth expiry, rate limits and timeouts. Say plainly what you verified and what is still a guess.
- **Production operations on request.** Booking, cancelling, charging a card or writing to production D1 happens only when the owner asks for that specific action. Collect credentials with `request_secret`, pass them through files or environment variables, and keep their values out of output, commits and logs. Create Cloudflare tokens with the `cf` CLI at the narrowest scope, and report each token you create.

## PRs

- **Own the review loop.** After opening or pushing a PR, call `watch_pull_request` and keep going without being asked: read the PR-Agent summary and inline findings, fix every actionable one (adding a regression test where it fits), run validation, push, reply on each thread and resolve it, and repeat. You are done when `test` and `review` are green on the latest head and every thread is resolved. A disputed finding gets your evidence on the PR and the owner's decision. The `ai-review-override` label is applied only with the owner's explicit authorization for that PR. The owner merges.
- [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) for commit messages and PR titles (`feat(booking): …`, `fix(monitor): …`, `ci: …`). One feature per PR, branched from `main`; follow-ups go to the same PR.
- PR descriptions state the final behavior: **Summary** (a sentence or two), **Evidence** (validation actually run, with numbers, and what wasn't run), **Merge Danger** (one-way or two-way door, blast radius, any manual step before or after merge).
- Update README.md and DESIGN.md in the same PR when behavior, commands, secrets or operations change, editing sections in place so they describe the current system.

## Validation

- Code: `npm run typecheck` and `npm test`. Behavior changes get tests against the fakes; extend `test/fakes.ts` when Inflow gains a response shape.
- Docs-only: link and content review plus `git diff --check`.
