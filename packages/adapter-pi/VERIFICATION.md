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
| Skip switching to saved history on resume           | Explicit native resume reloads the saved session before any prompt                     |
| Swap steering and follow-up delivery                | Steering and follow-up carry their native delivery modes                               |
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

- Remove cold-fork source cwd or deliver input before cloning. The cold clone process test must fail.
- Remove the native header byte bound or absolute cwd validation. The cold header rejection test must fail before process launch.

- Demote oversized blocking dialogs to notices. The translator and transport dialog-cap tests must reject successful completion.
- Ignore native stream errors. The LF stream failure test must deliver no later records.

- Remove cold-fork admission or fail to release it after rejection. The concurrent cold-fork test must fail.

## Review regressions

All cases are **not executed (tests run at merge)**. Runtime confirmation needs run at merge.

| Mutation                                                                 | Public behaviour guard                                                                                         |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Emit turn.ended while native dialogs remain, or discard deferred failure | Translator pending-dialog, timeout-isolation and deferred-failed-outcome tests apply facts through core        |
| Skip saved header validation or ignore its expected native ID            | Missing, empty and replaced saved histories fail public session reopen before input                            |
| Accept a different native ID at the same pathname                        | Native identity mismatch process test rejects resume                                                           |
| Forget navigation marker or append it before navigating                  | Earlier-user/assistant and root rollback retain actual context through clone, source restoration and reopen    |
| Append a marker after cancelled navigation                               | Cancelled navigation preserves native file bytes and active context                                            |
| Remove control-secret redaction                                          | Injected asserted secret is echoed on send, recv and stderr and must be absent in all three                    |
| Repeat full raw per final block                                          | Public translator facts retain unknown metadata while aggregate serialized bytes stay below three input frames |
| Remove final block cap                                                   | 257 final blocks cannot produce messages or successful completion                                              |
| Repeat or misplace cumulative block separators/suffixes                  | Multi-block shell output yields exactly abc, def, ghi with two separators and eleven bytes                     |
| Reject a legacy header without version                                   | Public cold-fork and reopen accept native v1 headers and preserve source                                       |
| Discard known safe history diagnostics                                   | Public daemon socket returns navigation-not-acknowledged, without pointing at nonexistent notices              |
| Block dialog answers with the native history-operation lock              | Fork confirmation can be answered while the fork is pending, and its returned reference resumes context        |
| Await native control completion in serialized socket dispatch            | A pending control leaves the same socket able to receive ping and return pong before the control finishes      |

Additional scaling benchmarks in `bench/scaling.ts` include final-envelope persistence
serialization at 16–256 blocks and cumulative multi-block output at 1–256 KiB prefixes.
Ops/s, serialized bytes/frame, emitted bytes and peak RSS require a merge-time run.
No measurements are claimed. Incoming cumulative frames must still be parsed in full;
ace copies only their new output suffix.
