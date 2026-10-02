# Model catalog mutation audit

Date: 2026-10-02. All mutations were applied separately to production code,
tested through the public API, and reverted immediately. Every mutation produced
an assertion failure. No mutation depended on lint or typecheck failures.

| Mutation                                 | Behavior that failed                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| TTL treats fresh rows as stale           | cached pickers return immediately through TTL and revalidate stale rows once         |
| Disable single flight                    | single flight coalesces real app-server spawns                                       |
| Reuse previous login revision            | login change clears the old account immediately and ignores its late refresh         |
| Ignore requested page offset             | provider and instance filters page only their own models                             |
| Reverse strongest preference comparison  | strongest role picks its highest available preference and native fast tier           |
| Allow unknown image support              | image requirement excludes models with unknown image support                         |
| Allow automatic hidden/deprecated choice | automatic policies skip hidden and deprecated choices even if preferred              |
| Discard native Codex efforts             | Codex discovery pages model/list without ever starting a turn                        |
| Replace native priority tier parameter   | Codex discovery pages model/list without ever starting a turn                        |
| Stop credential redaction                | raw metadata retains extensions but caps multibyte content and redacts credentials   |
| Drop account filter                      | unavailable explicit model and unsupported parameters never silently fall back       |
| Discard supported Claude efforts         | Claude discovery initializes only and keeps resolved aliases and supported Fast mode |

After reverting all twelve mutations, `bun run check` passed with 401 tests
passing and four existing tests skipped.
No GitHub CI is used.

After integrating remote access from `origin/main`, the full gate passed again
with 444 tests passing and four existing tests skipped, including paired-device
scope checks for the catalog queries.

After integrating the MCP server from `origin/main`, the final gate passed with
496 tests passing and four existing tests skipped.

## PR 32 review follow-up

The review separately mutated hidden and deprecated filtering, stderr accounting,
and provider-default selection. All four survived the older tests. The flags now
have independent behavior tests, stderr flooding precedes an otherwise valid
reply, and defaults appear after a non-default model.

Applied the following nine mutations individually, required an assertion failure
from the named public behavior, and restored the production file in a finally
block. All nine were killed. None relied on typecheck or lint failures.

| Mutation                                      | Behavior that failed                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Ignore hidden only, review mutation 7         | automatic policies skip hidden choices even if preferred                                                                 |
| Ignore deprecated only, review mutation 8     | automatic policies skip deprecated choices even if preferred                                                             |
| Remove stderr accounting, review mutation 21  | stderr flood rejects otherwise valid metadata and reaps the CLI                                                          |
| Ignore provider defaults, review mutation 23  | default role preserves the provider default effort and tier; strength without a policy order states the default fallback |
| Overwrite the first duplicate preference rank | duplicate policy preferences preserve the first occurrence's priority                                                    |
| Remove the explanation length cap             | maximum-length policy fields produce a schema-valid concrete resolution                                                  |
| Forget failed deletions                       | failed durable removal is reported and retried before shutdown and restart                                               |
| Skip discovery cleanup during close           | close reaps an owned hung app-server with synchronous storage                                                            |
| Accept an incomplete final OpenCode object    | OpenCode rejects an incomplete final object after complete earlier models                                                |

Before fixing production code, the four blocker reproductions failed through
public APIs: removal resolved instead of rejecting, the maximum-length resolution
failed its output schema, duplicate preferences selected b instead of a, and
close returned before the real child was reaped. All four pass after the fixes.
The socket suite also verifies maximum-length replies and cached list/resolve
requests on the same connection while its refresh remains pending.

The merged main includes notifications and encrypted relay support. Local checks
use the full gate, with VITEST_MAX_WORKERS=4 and 30-second test/hook runner
watchdogs when the shared machine is busy. Default five-second process-startup
tests timed out even with one worker. No assertion or skip is changed, and
production deadlines remain unchanged.

Final follow-up gate: 606 tests passed, four existing skips; format, lint,
typecheck and the 1,500-line check passed for all 255 source files. Command:
`VITEST_MAX_WORKERS=4 bun run check --testTimeout=30000 --hookTimeout=30000`.
No CI was run or watched.
