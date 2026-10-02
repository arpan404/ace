# AGENTS.md

ace is a multi-agent coding environment: a local daemon that drives the user's installed coding-agent CLIs, plus desktop (Electron), web and mobile (Expo) clients. Read `README.md` and `docs/adr/` before making design changes.

## Clean-room rule

ace is a clean-room rewrite. Never copy, paste or closely paraphrase code from t3code, `arpan404/ace-legacy`, or any other codebase whose license we haven't explicitly accepted. Reading other projects to learn which interfaces exist is fine; the implementation must be written fresh from our own specs and from primary provider sources.

## Priorities

1. Correctness of agent state. Never show an agent as done while any part of its tree is still working or waiting on a human.
2. Reliability under restarts, reconnects and partial streams.
3. Performance.

When these conflict, choose in that order.

## Decisions that are settled

- Providers are reached only through the user's own installed, logged-in CLIs. ace never collects, stores or proxies provider credentials and is never hosted (ADR 0002).
- Daemon runtime is Node 24+. Bun is the package manager and script runner. TypeScript everywhere. Zod 4 for schemas. No Effect (ADR 0003).
- `packages/protocol` is schema-only: Zod schemas and inferred types, no runtime behaviour beyond parsing.

## Code conventions

- TypeScript must be erasable (`erasableSyntaxOnly`): no enums, namespaces or parameter properties. Node runs `.ts` files directly.
- Relative imports use the `.ts` extension.
- Keep modules small and single-purpose. If a file passes ~400 lines, split it.
- Decode provider data leniently: unknown event types and fields are kept as raw data, never dropped and never fatal.
- Before adding logic, check for an existing module that owns it. Duplicate logic across packages is a bug.

## Tests

Test behaviour, not structure. Every test must fail if the behaviour it names breaks, and keep passing through a refactor that preserves behaviour.

- Test through the public API: given inputs or facts, assert outputs, emitted events, stored rows, socket messages or process effects.
- Name tests after the behaviour they guard ("thread stays waiting while a background shell is still running"), not after functions.
- Prefer real edges: temp SQLite, real child processes, real local HTTP/WebSocket servers. Mock only what you can't control (time, randomness, provider CLIs), and only at the boundary.
- For each test ask: if the logic it covers broke, would it fail? If not, fix it or delete it.

Don't write tests that:

- check that a file, function, export or method exists;
- assert on internal state shapes or private helpers when a public result can be asserted;
- assert that an internal collaborator was called N times or with given arguments, when the observable result can be checked;
- re-implement the code under test to compute the expected value;
- only restate types, schemas or constants;
- snapshot large structures without a behavioural reason;
- would still pass if the implementation were a stub returning plausible values.

Reviews reject PRs containing such tests.

## Commands

- `bun install`
- `bun run fmt` / `bun run fmt:check` (oxfmt)
- `bun run lint` (oxlint)
- `bun run typecheck`
- `bun run test` (Vitest). Never run `bun test`; that is Bun's own runner.
- `bun run check` runs all of the above. It must pass before a task is complete.

## Recording fixtures

`tools/recorder` starts real sessions on the user's CLIs and spends their subscription quota. Only run it when the user has asked for it.
