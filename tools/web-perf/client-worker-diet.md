# Client worker bundle diet

Measured on 2026-10-05 against main `f4511043`. Vite production builds, Node gzip level 9,
1 KB = 1,024 bytes. No budgets changed.

| Worker budget             |    Before |     After |  Removed | Budget |
| ------------------------- | --------: | --------: | -------: | -----: |
| Eager client worker       | 58.066 KB | 53.083 KB | 4.983 KB |  60 KB |
| Including all lazy chunks | 72.634 KB | 66.570 KB | 6.063 KB |  73 KB |

Before, the eager entry was 59,460 gzip bytes. Lazy service wire, file transfer and attachments
added 13,097, 1,189 and 631 bytes respectively. After, the entry and shared eager core are 465
and 53,892 bytes; one shared lazy services chunk adds 13,811 bytes. Total headroom rises from
0.366 KB to 6.430 KB. Tiny lazy imports still resolve their own module namespaces, but share
one physical chunk.

The analyzer uses Rolldown's retained module records. These are rendered bytes before
minification, including pure annotations and factory wrappers, rather than additive gzip
attributions. Compression is measured only at chunk boundaries.

| Package         | Before eager | Before lazy | After eager | After lazy |
| --------------- | -----------: | ----------: | ----------: | ---------: |
| Zod             |      126,910 |           0 |     111,133 |          0 |
| Protocol        |      111,859 |      74,815 |      90,837 |     76,609 |
| Client          |       88,618 |       9,861 |      88,689 |     10,912 |
| Client worker   |       31,884 |           0 |      31,818 |          0 |
| Projection      |       11,921 |           0 |      11,921 |          0 |
| Web and bundler |        4,031 |           0 |       4,041 |        348 |

The largest eager modules before the change were Zod core schemas at 43,915 bytes, classic
schemas at 22,062, client.ts at 20,080, Zod util at 14,729, host.ts at 14,502 and thread-store.ts
at 13,386. After, they are 42,774, 21,366, 20,155, 13,850, 14,502 and 13,386 respectively.

Specific protocol costs explain the changes:

| Module           |      Before |       After | Reason                                             |
| ---------------- | ----------: | ----------: | -------------------------------------------------- |
| accounts.ts      | 6,476 eager |  4,691 lazy | Core account IDs have their own module             |
| history.ts       | 4,124 eager |  4,153 lazy | Core imported provenance has its own module        |
| agent-control.ts | 5,962 eager | 1,254 eager | Unused delegation schemas disappear                |
| orchestration.ts | 4,289 eager | 1,894 eager | Unused schemas disappear                           |
| conductor.ts     | 5,172 eager | 4,020 eager | Unused review and alternate plan schemas disappear |
| screen-v2.ts     |  8,507 lazy |  3,151 lazy | Unused service-side schema constructions disappear |
| Zod mini schemas | 5,591 eager |           0 | Worker envelopes reuse classic constructors        |

Protocol initializers run in pure factories so tree shaking can discard entire unused
constructions, including shape and options spreads. Refinement and parser bodies are untouched.
JSON-schema stripping remains enabled; metadata stripping also removes descriptions and the
unused registry. Worker-only method omissions remove unused string checks, async/fallback
wrappers and error formatters. Page schemas keep their fallback and normalization methods.

The build guard checks the actual static chunk closure for accounts, history, settings,
long-thread and service-wire modules, page remote/mirror code and Zod mini schema classes.
Behavior tests compare raw and optimized bundles over fake-daemon traffic and malformed
variants, including decoded defaults, transforms and validation issue paths/messages. Port
envelopes are compared too. The guard test rejects an eager history import by name and executes
a permitted lazy import in Node. Client and worker regressions check imported provenance and
invalid account IDs without involving provider CLIs.

Reproduce the final sizes and breakdown with `node tools/web-perf/src/bundle.ts --analyze`.

## Browser regression follow-up after #126

Merged main `bdb7079f` and rebuilt the baseline and optimized production bundles. No budgets
changed. Sizes below are gzip KB (1,024 bytes), rounded to three decimals.

| Worker budget             |      Main | Fixed branch |  Removed | Budget |
| ------------------------- | --------: | -----------: | -------: | -----: |
| Eager client worker       | 58.414 KB |    53.428 KB | 4.986 KB |  60 KB |
| Including all lazy chunks | 72.981 KB |    66.915 KB | 6.066 KB |  73 KB |

The entry is 0.450 KB, shared eager core 52.978 KB, and shared lazy services 13.487 KB. The
current retained package bytes are: Zod 111,111 eager; protocol 90,837 eager / 76,609 lazy;
client 88,727 eager / 10,912 lazy; client-worker 35,206 eager; projection 11,921 eager;
web/bundler 2,761 eager / 348 lazy. The earlier tables record the original `f4511043` baseline.

The worker method omissions incorrectly included Zod's `.array()`. They apply to every Vite
worker, including the perf worker, where `@ace/core` constructs `RawPayload.array()`. The built
worker threw before the transcript appeared. Browser origin replies also need this method at
runtime. Restoring it fixes the real browser path while retaining the size savings.

Both original search-jump cases pass unchanged, including three tool-output hit jumps and the
empty Errors filter. All six other web-perf process tests pass, run serially by file. The
six-round million-item long-thread benchmark passes: median search-to-hit 281 ms, interaction
p95 72 ms, longest task 104 ms, peak 1,126 DOM nodes, and retained heap growth 2.20 MB.
Typecheck, lint, formatting, size/UI/dependency checks, protocol docs check, and all bundle
budgets pass. The full suite was not rerun for this follow-up.
