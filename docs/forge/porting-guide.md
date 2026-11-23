# The forge under ADR 0224: no port, and what follows the owner's answer

For builders asked to work on `@ace/forge` after
[ADR 0224](../adr/0224-git-reads-move-in-process-git-writes-and-forge-stay.md). Read the ADR and
[behaviour.md](behaviour.md) first. The ADR decides that the forge stays TypeScript: the daemon
spends 1–3 ms of a host request, the person's CLI about 31 ms of CPU and a fresh TLS connection,
and the host the rest (behaviour.md §7). There is no Rust work item. The items below open only if
the owner answers ADR 0224's question 3 "yes" (the daemon may hold a host token in memory); until
then, a builder changing the forge follows the rules and touches no transport.

## Rules for any forge change

1. **The person's CLI is the only route to a host** (ADR 0002) unless question 3 says otherwise.
   Never read a CLI's configuration or keychain entries, never store a token, never log one.
   `redact` (`redact.ts:1`) runs on every untrusted body before it is kept.
2. **Same interface.** `GitHubForge`, the readers, writers and readiness functions, `ForgeError`
   and its kinds, `MutationDispatch` and `ForgeStore` keep their signatures, results and timing
   (behaviour.md §1). The 13 browser entries stay plain JavaScript with no Node or native import:
   `apps/web`, `ui-core` and `fake-daemon` load them.
3. **Write certainty is contract** (behaviour.md §4): what counts as a write, the refused-status
   set, the 10-minute fence, dispatch before or after the process (or connection) started. A
   transport change must keep "certainly not sent", "certainly refused" and "uncertain" distinct.
4. **Same numbers.** 4 MiB per reply, 30 s per request, 16 KiB log tails, 8 MiB per snapshot read
   budget, 60 s identity verification, 2,000 pending feedback entries.
5. **Tests**: the class (a) files are the proof and are not edited; run each alone
   (`bun --bun x vitest run <file> --maxWorkers=4`, after `test -f`), never the full suite or the
   tier scripts. No real host, ever: process tests use `fakeGh` (`testing/fixtures.ts:122`), unit
   tests an injected runner.
6. **Measure** with `node packages/forge/bench/transport.ts` and `node packages/forge/bench/status.ts`
   before and after, and report both.

## Work items if the owner allows in-memory tokens (question 3)

GitHub first, behind one switch, `ACE_FORGE_HTTP=github`, read once in
`packages/provider-kit/src/native-switches.ts`; unset is today's `gh api` per request.

| Item | What                                                                                                                                                                                                                                                                                                                                     | Files (yours)                                                                | Proof                                                                                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| F1a  | A token source: `gh auth token --hostname <host>` through the existing runner, held in memory per host and account, dropped on `identityChanged`, a 401, account switch or `close()`; never written, logged or put in an error. The pinned account rules of `pinned-runner.ts:36` apply unchanged.                                       | `packages/forge/src/token-source.ts`                                         | `identity-probes.process`, `readiness.process`, `command.process`; one new test file for token lifetime, flagged as new behaviour in its commit |
| F1b  | A transport behind `GhApi` (`http.ts:97`) that sends the same request (`Accept`, ETag and `If-Modified-Since`, GraphQL bodies) over one kept-alive HTTPS connection per host with Bun's `fetch`, and returns the same `Page` (status, headers, body, bytes). Limits, redaction, caching and `MutationDispatch` stay where they are.      | `packages/forge/src/http-transport.ts`, one `if` in `http.ts`                | every `GitHubForge`/`GitHubInbox`/`GitHubRepositories` (a) file of behaviour.md §8, against F1c's fake host                                     |
| F1c  | A local fake HTTPS host that serves `fakeGh`'s fixture files (`testing/fake-gh.mjs` reads them today), with a test certificate trusted only by the test process, so the same (a) files run against both transports.                                                                                                                      | `packages/forge/src/testing/fake-host.ts`, `fakeGh` gains a transport option | the (a) files pass unchanged against `fakeGh` and against the fake host                                                                         |
| F2   | Only if F1 is measured and the owner still wants Rust: the same transport as `ace-forge-http` (`reqwest` 0.13 with `rustls` and `rustls-platform-verifier`, using the OS's roots, so no bundled root store and no licence outside `deny.toml`). It returns status, headers and body bytes; TypeScript still decodes, redacts and shapes. | `native/daemon/crates/ace-forge-http/`, `ace-daemon-node/src/forge.rs`       | as F1b; ships only if it beats F1b on the transport bench                                                                                       |

GitLab, Gitea/Forgejo, Bitbucket and Origin stay on their CLIs: their token commands differ (and
`tea` keeps tokens in a configuration file ace would have to read), so each needs its own answer
from the owner before it gets an item.

What never moves: decoding and Zod schemas, `ReviewIndex`/`StatusRevisions`, `ForgeStore`, write
admission lists, readiness wording, and the browser entries. They cost microseconds to a
millisecond a request and are shared with the web app.
