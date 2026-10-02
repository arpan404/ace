# Preview verifier follow-up

The owner's static-only validation rule applies. No tests, probes, benchmarks,
mutations or CI were executed in this follow-up. Runtime assertions need run at
merge. The earlier verifier evaluated `331c3e0`; this follow-up first merged
`origin/main` at `5494e21`, without rebasing, in `e5b1ce9`.

## Findings addressed

- R1: provider-kit now declares Zod as a dev dependency, with a matching lockfile
  workspace entry. The existing public cancellation regression validates child
  JSON and error data through that dependency. Its execution needs run at merge.
- B5: cancellation and byte-buffer assertions remain in the public API tests.
  Preview and cancellation suites now join main's process project, which provides
  private TLS fixtures, two workers, integration deadlines and process teardown.
  Concurrent stability and outer-timeout cleanup need run at merge.
- Native chunk coverage: oversized and overlapping chunks must emit RESET,
  destroy the invalid native socket, release capacity and permit a replacement
  stream to receive a real HTTP response at maxStreams=1. Needs run at merge.
- Redirect coverage: gateway and relay tests now exercise double backslashes and
  mixed slash/backslash authorities, plus ordinary relative and external
  references. Redirect rewriting uses the browser URL parser with the preview
  origin as its base. Needs run at merge.
- Memory wording: terminal URL and launch-line tests cover parsing and process
  termination. Queue counters conservatively sum retained work across stages,
  including potentially shared frames. Only the isolated download test asserts
  retained byte-buffer growth. Its memory assertion needs run at merge.
- Merge conflicts: main's model instances remain the fifth startup argument;
  preview options are sixth. Main's raw process owner and total-output cap coexist
  with preview's line cap and probe cancellation. Real-process and startup HTTP
  regressions preserve both responsibilities. Needs run at merge.
- Integration I10: a browser preview can mutate its app, so daemon link issuance
  and ongoing authorization now use the existing `allows(device, "operate")`.
  A paired-device test denies read-only credentials and rejects a revoked
  operator's POST without another upstream mutation. Needs run at merge.

I10 also names browser/plugin/screen and an alternate read route from PRs
#24/#28/#29/#33. Those routes are absent from this branch and merged main.
Existing `output.read` and `items.page` retain both read-scope and per-thread
checks. Preview registration/launch stays trusted host control, and relay grants
remain injected by the authenticated connection owner. No thread-status
precedence changes were made.

## Mutation mapping

Every case below is **not executed (tests run at merge)**. Intended assertion
failures and final runtime confirmation need run at merge.

| Mutation                                    | Public behaviour assertion                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| Remove only HMAC equality                   | Wrong 32-byte signature and tampered claims get 401; valid cookie works      |
| Remove only DATA frame ceiling              | Otherwise-valid oversized DATA closes the ready stream/channel               |
| Recognize only literal `//` redirects       | Mixed slash/backslash HTTP redirects stay on preview origin                  |
| Remove native chunk size bound              | Oversized chunk emits RESET and replacement HTTP succeeds                    |
| Allow overlapping native chunks             | Overlap emits RESET and replacement HTTP succeeds                            |
| Delay stream removal on close               | Credit/writer blocked TCP close frees maxStreams=1 capacity                  |
| Omit credit-wait wake                       | Closed socket releases its held payload without new CREDIT                   |
| Omit writer cancellation                    | Closed socket releases its payload while writer remains blocked              |
| Stop accounting pending payload/frame bytes | Blocked TCP work reports positive payload/frame counters                     |
| Use blocking file open                      | Four FIFO loads reject without stopping an ordinary file read                |
| Omit regular-file validation                | FIFO loads reject with the regular-file error                                |
| Retain scanner-owned Set                    | A reused Set emits both removal and addition                                 |
| Ignore probe abort                          | Owned child server closes before probe abort rejection                       |
| Remove paired operate check                 | Read-only device cannot obtain a mutation-capable preview                    |
| Ignore paired revocation                    | Revoked operator's cookie cannot deliver another POST upstream               |
| Drop line cap in raw-owner merge            | Oversized line exits with output-limit when both caps are set                |
| Drop total-output cap in merge              | Small repeated lines exit with output-limit when both caps are set           |
| Drop preview wiring alongside model startup | Startup preview returns the real upstream HTTP body while catalog reads work |

## Static gate

`bun run fmt`, `bun run lint`, `bun run typecheck` and `bun run check:size` pass.
Dependency links and the lockfile were refreshed with lifecycle scripts disabled.
No claim of a full `bun run check`, concurrent stability, mutation results,
final-tree throughput or CI success is made. Historical benchmark numbers remain
in the PR description as pre-policy measurements; current numbers need run at merge.

## Latest main integration

Merged main `fe670b0` after independent approval. Protocol subpaths retain both
`./preview` and `./forge`. Process-test globs retain main's delivery, shutdown,
pressure, Docker and workspace entries alongside all preview and cancellation
entries. Daemon integration retains model catalog requests, notification
services, remote pairing, scoped reads/commands, input limits, injected delivery
runtime and awaited presence cleanup alongside preview HTTP, revocation and
shutdown. Startup failure uses main's timer-stop handle and preview cleanup.

Preview already uses main's device authentication, `allows` scope predicate and
revocation API. The preview authority receives the daemon's injected delivery
clock through RemoteAuth. An added public HTTP regression advances that clock,
requires an old link to return 401 and a fresh link to return 303. Mutation:
discard the injected delivery clock for preview authorization,
**not executed (tests run at merge)**. Runtime confirmation needs run at merge.

All permitted static checks pass on the merged tree; the size gate covers 596
source files. Dependency installation used `--ignore-scripts`. No tests, probes,
benchmarks, mutations, full `bun run check` or CI were run for this merge.
