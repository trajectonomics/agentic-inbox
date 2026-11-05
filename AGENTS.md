# AGENTS.md

Instructions for AI coding agents in `trajectonomics/agentic-inbox` (`agentic-inbox`).

## Rules

1. Never commit to `main`. Branch (`feat/*`, `fix/*`, `docs/*`, `chore/*`) and open a PR.
2. Never commit secrets, `.env` files, or Cloudflare API tokens / credentials.
3. Architecture & Purity: Keep domain and utility logic pure and deterministic where possible (dates, search parsers, schemas). Keep Worker and Durable Object boundaries explicit with typed RPC contracts.
4. Bun only: `bun install`, `bun test`, `bun run <script>`. Do not add npm/pnpm/yarn lockfiles.
5. Done means `bun run check` passes (`bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`). `bun run format` fixes formatting and import order. Do not loosen `biome.json` simply to silence an error.
6. PR titles are conventional commits (`feat:`, `fix:`, `chore:`, etc.) because CI validates them (`.github/workflows/pr-title.yml`).

## Secrets & Environment Variables

- Never commit secrets, `.env` files, or Cloudflare API tokens / credentials.
- Use `wrangler secret put <KEY>` for production/staging secrets.
- For local development, use `.dev.vars` (modeled after `.dev.vars.example`) and ensure `.dev.vars` is never committed to source control.

## Scope & Architecture

`agentic-inbox` is a self-hosted email client and autonomous AI inbox agent running on Cloudflare Workers and React Router v7.

- **Frontend (`app/`)**: Built on React Router v7 and Vite, styled with Tailwind CSS v4 and `@cloudflare/kumo`.
- **Backend (`workers/`)**: Cloudflare Workers entrypoint (`workers/app.ts` & `workers/index.ts`).
- **Durable Objects (`workers/durableObject/`, `workers/agent/`, `workers/mcp/`)**:
  - `MailboxDO`: Per-mailbox isolated SQLite database (Drizzle ORM) for messages, threads, and folders.
  - `EmailAgent`: Durable Object managing AI workflows and tool execution.
  - `EmailMCP`: Model Context Protocol server exposing inbox operations to external agents.
- **Storage & Services**:
  - Cloudflare R2 bucket (`BUCKET`) for email attachments.
  - Workers AI (`AI`) for security scanning (prompt injection) and draft refinement.
  - Cloudflare Email Routing for inbound message handling.

## Agent skills

### Skills included in this repo

- **Matt Pocock Skills (`mattpocock/skills`)**: Complete engineering workflow including `/ask-matt`, `/tdd`, `/implement`, `/code-review`, `/wayfinder`, `/diagnosing-bugs`, `/codebase-design`, `/grill-with-docs`, etc.
- **Trajectonomics Internal Skills (`trajectonomics/internal-skills`)**: Organization-specific workflow including `/pick-the-issue` to discover unblocked GitHub issues.

### Reviewing a diff

`CODING_STANDARDS.md`: conventions a reviewer must check by reading the diff. Read it when reviewing, not when implementing.

### Issue tracker

GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Installing and updating skills

Skills come from [`mattpocock/skills`](https://github.com/mattpocock/skills) and [`trajectonomics/internal-skills`](https://github.com/trajectonomics/internal-skills) via the Vercel [`skills`](https://github.com/vercel-labs/skills) CLI and are pinned in `skills-lock.json`. The canonical copy is `.agents/skills/`; `.claude/skills/` holds symlinks into it.

- Update: `bun run skills:update` (or `bunx skills@latest update`)
- Check status: `bun run skills:check` (or `bunx skills@latest check`)

## Repository Information

- Repository: https://github.com/trajectonomics/agentic-inbox
- Package: `agentic-inbox`
