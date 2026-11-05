# Coding Standards

Read at **review** time. `bun run check` already enforces mechanical rules (formatting, strict types, tests, build). This file covers what tooling cannot: conventions a reviewer must check by reading the diff.

Decisions behind the architecture live in `docs/adr/`; domain vocabulary lives in `GLOSSARY.md`.

## Public API & Domain Error Codes

- Every exported function, helper, or schema carries a concise JSDoc comment stating what it **is**, not just how it works internally.
- A rule that can reject input gets its own domain error code enum/union. One code per rule: never widen an existing code's meaning, and never let two distinct rules share one.
- Payloads passing between the frontend, Cloudflare Workers, and Durable Objects must have runtime validation via explicit Zod schemas in `workers/lib/schemas.ts`.
- Values returned from shared domain helpers are immutable. Caller-supplied objects are never mutated in place.
- Errors thrown or returned from API routes mirror caller-supplied field paths rather than internal SQLite or Worker variable names.

## Purity & Determinism

- Core shared domain logic (`shared/dates.ts`, `shared/folders.ts`, `app/lib/search-parser.ts`) must remain pure: avoid hidden global state, unseeded randomness, or non-deterministic locale assumptions.
- Date and locale formatting helpers must specify explicit fallback options and deterministic defaults.
- Real-world integration requirements (e.g. Workers AI, R2, Cloudflare Email) belong behind clean adapter modules in `workers/lib/`.

## Naming & Domain Language

- Use `GLOSSARY.md` vocabulary strictly. Synonyms (e.g., mixing "mailbox" with "account", or "thread" with "conversation") in a diff are considered defects.
- When an API requires a duration, size, or count, make the unit explicit in the type and parameter name (e.g. `timeoutMs`, `bytes`).

## Tests

- One test per error condition, asserting specific error messages/codes rather than just checking that an exception was thrown.
- Test names state the domain behavior or invariant being verified, not the internal function under test.
- New unit test files belong adjacent to the module under test (`*.test.ts`) and must satisfy the 200-line ceiling.

## Files & Boundaries

- One concern per file.
- Keep RPC boundaries between Durable Objects (`MailboxDO`, `EmailAgent`, `EmailMCP`) typed and clean.
