# Pi verification plan

Static checks only for this revision. No tests, benchmarks, mutation runs or
provider recordings were executed. Runtime claims below need a run at merge.

## Intended mutations

Every case is **not executed (tests run at merge)**.

| Mutation to production logic                        | Behaviour test designed to kill it                                                     |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| End the run on `agent_end`                          | Retry and compaction after agent end keep the thread live until Pi settles             |
| Close all dialogs on `agent_settled`                | A settled event leaves a dialog pending until its matching native answer               |
| Expire every dialog when one timeout fires          | Native dialog timeout expires only the timed interaction                               |
| Open an interaction for `notify`                    | Fire-and-forget and unknown extension updates retain raw data without blocking         |
| Append the whole cumulative shell result again      | Shell output appends only new suffixes and completion cannot erase surviving work      |
| Drop surviving tools at settled                     | Shell output appends only new suffixes and completion cannot erase surviving work      |
| Append final assistant snapshot after deltas        | Streamed assistant text is not duplicated by the final authoritative message           |
| Drop live bookkeeping on overflow and complete      | Live tool capacity overflow cannot turn into a successful settled thread               |
| Leave interactions pending after process death      | Unexpected exit expires dialogs and does not report successful completion              |
| Reply to select with option id rather than label    | Selection answers use native offered labels and cannot be sent twice                   |
| Omit restoring source after fork                    | Native fork creates a resumable reference and preserves the source session             |
| Treat navigation acceptance as success without ack  | An accepted rollback command without acknowledgement is not success                    |
| Ignore extension cancellation                       | Cancelled native navigation does not become successful rollback                        |
| Omit `clear_queue` before abort                     | Interrupt clears native queued continuation before aborting                            |
| Accept unknown version or emulate supervised policy | Unknown versions and unsupported permissions are refused before process launch         |
| Treat Unicode separators as record boundaries       | LF framing preserves Unicode separators and split UTF-8 characters                     |
| Remove the LF byte cap                              | An unterminated oversized JSONL record fails before another record can be delivered    |
| Forward an expired lease or omit MCP error hook     | Pi extension forwards scoped tools, structured results and MCP errors across real HTTP |

## Performance measurements pending

`bench/translation.ts` measures text-delta translation and LF byte framing, reporting
ops/s and peak RSS. It is non-gating and unexecuted. Both paths are proportional
to frame/chunk size and retain bounded state. Tool output arrives as native cumulative
frames; ace reads the incoming frame once and appends the new suffix, without retaining
an accumulated output copy. MCP forwarding uses the official client with bounded
HTTP body streams and call admission. Native history controls are cold operations;
Pi itself scans native history and ace fails visibly if a response exceeds 1 MiB.

Further cases, all **not executed (tests run at merge)**:

- Remove process identity from run/item keys. The reopened-processes test must fail.
- Remove the native read-only allowlist. The read-only launch test must expose write availability.
- Remove lease bearer redaction. The MCP bearer-echo test must expose the injected secret.
- Omit lease revocation on opening failure. The opening-failure test must leave the lease live.
- Ignore operate authorization. The read-scoped wire client test must receive a native-history result.
- Re-execute a duplicate receipt or accept changed content. The Pi wire receipt test must return another native reference.
- Accept an unknown Pi version. The Pi discovery admission test must report workspace rather than provider availability.
