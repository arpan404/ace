# Mutation verification

Run `node packages/history-import/bench/mutations.ts` from the repo root. Nine deliberate production changes each failed the named public behavior test. All source bytes were restored after each run. Syntax/import failures do not count; the reporter must contain a failed assertion for the selected behavior.

| Production mutation                    | Behavior test                                                                  | Result |
| -------------------------------------- | ------------------------------------------------------------------------------ | ------ |
| Reread unchanged files                 | warm scans read zero content and a changed source is the only content reread   | Failed |
| Discard imported message text          | workspace lists retain native metadata and imports retain resumable provenance | Failed |
| Lose resumable native identity         | workspace lists retain native metadata and imports retain resumable provenance | Failed |
| Omit subagent history                  | Claude sidechains become child agents and changes are indexed independently    | Failed |
| Drop unknown raw records               | unknown native records survive as canonical raw notices                        | Failed |
| Ignore cancellation at pull boundaries | cancellation rolls back while a slow sink enforces pull backpressure           | Failed |
| Never publish a committed thread       | workspace lists retain native metadata and imports retain resumable provenance | Failed |
| Return corrupt zero-filled blob bytes  | oversized records stream losslessly into bounded blob chunks and pages         | Failed |
| Publish history after a source change  | source changes during import roll back all staged history                      | Failed |
