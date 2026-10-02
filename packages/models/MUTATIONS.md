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
