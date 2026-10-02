# Usage regression and mutation coverage

Status for every case below: **not executed (tests run at merge)**. The owner
prohibits tests, probes, benchmarks and mutation executions in this revision.
These are intended guards established by static inspection, not claims of
runtime mutation kills. Review survivors 23 and 25 now have observable assertions.

Prefixes below identify public behavior tests in `src/`, unless a path is given.

| #   | Production mutation                                         | Guarding behavior                                                                                     |
| --- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | Count full cumulative samples                               | accounting: cumulative replays                                                                        |
| 2   | Zero output                                                 | fixtures: Codex fixture totals                                                                        |
| 3   | Zero reasoning                                              | fixtures: Claude result accounting                                                                    |
| 4   | Zero reported dollars                                       | accounting: prices separate                                                                           |
| 5   | Track unkeyed increments cumulatively                       | accounting: unkeyed increments                                                                        |
| 6   | Merge counter keys                                          | accounting: cumulative replays                                                                        |
| 7   | Remove Claude run scope                                     | accounting: Claude legacy; fixtures: Claude result accounting                                         |
| 8   | Remove legacy cache normalization                           | accounting: Claude legacy; fixtures: Claude result accounting                                         |
| 9   | Charge subscriptions                                        | accounting: subscription usage                                                                        |
| 10  | Ignore subtree                                              | accounting: parents include                                                                           |
| 11  | Zero cached price                                           | accounting: prices separate                                                                           |
| 12  | Zero one-hour write price                                   | accounting: prices separate                                                                           |
| 13  | Ignore overrides                                            | accounting: price overrides; daemon usage.server: settings overrides revalue history                  |
| 14  | Force UTC                                                   | queries: day boundaries                                                                               |
| 15  | Accept replay gaps                                          | backfill: worker backpressure                                                                         |
| 16  | Exclude quota start                                         | queries: burn rates                                                                                   |
| 17  | Ignore filters                                              | queries: groups and filters                                                                           |
| 18  | Hide truncation                                             | queries: groups and filters; query pages bound returned bytes                                         |
| 19  | Price unknown equivalents                                   | accounting: unknown models                                                                            |
| 20  | Reject model-bearing core facts                             | core usage-metadata: usage metadata reaches canonical events                                          |
| 21  | Disable cycle guard                                         | queries: cross-thread parents                                                                         |
| 22  | Remove RPC admission cap                                    | backfill: worker backpressure                                                                         |
| 23  | Omit emitted core model (review survivor)                   | core usage-metadata now asserts `model`, output and cached input                                      |
| 24  | Commit a failed transaction                                 | accounting: a failed transaction                                                                      |
| 25  | Drop legacy OpenCode reasoning (review survivor)            | accounting: legacy OpenCode increments include cache input and reasoning output                       |
| 26  | Reinstate the 512-character model cap                       | daemon usage-replay: retained long models; backfill: backfill resumes (513-character canonical model) |
| 27  | Clamp negative pricing categories                           | accounting: partial cache reports preserve signed daily adjustments                                   |
| 28  | Stop emitting durable deletion tombstones                   | daemon usage-replay: thread deletion is durable                                                       |
| 29  | Leave counters or quota increments after deletion           | daemon usage-replay: thread deletion is durable, including recreated agent IDs                        |
| 30  | Keep deferred daily increments after deletion               | accounting: deletions in the same transaction                                                         |
| 31  | Read full canonical payloads or ignore the byte budget      | daemon usage-replay: replay excludes large retained metadata                                          |
| 32  | Route shutdown through ordinary admission                   | backfill: closing a saturated worker drains every accepted write                                      |
| 33  | Reinstate the $1e12 result cap or hide saturation           | accounting: large provider reports remain queryable                                                   |
| 34  | Keep replay pinned to incompatible retained facts           | daemon usage-replay: incompatible retained usage advances coverage                                    |
| 35  | Hide quota overflow or forecast from saturated observations | queries: quota aggregates saturate numeric overflow                                                   |
| 36  | Materialize an unrestricted query page                      | queries: query pages bound returned bytes                                                             |
| 38  | Remove analytics subscription capacity                      | daemon usage-replay: analytics subscription admission stays bounded                                   |

Each blocker received a public regression before the implementation changed.
Failing/passing executions and all mutation kills **need run at merge**. No
runtime acceptance, flakiness verdict or post-fix benchmark is asserted here.
