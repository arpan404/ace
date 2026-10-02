# Settings verification

Each mutation below changed production code, ran the named public behavior test and produced a failing assertion. Each change was reverted before the next run. Commands used `bun run test <test file> -t <behavior>`.

| Production mutation                                              | Failing behavior                                                                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Reverse layer precedence                                         | each key resolves from the highest present layer and reports its provenance             |
| Skip migration write-back                                        | a v1 document migrates on read and is written back exactly once                         |
| Replace the settings container on set, losing unknown keys       | sets retain unknown fields, comments, trailing commas and local indentation             |
| Reserialize before editing, removing comments                    | sets retain unknown fields, comments, trailing commas and local indentation             |
| Reset last-good state on invalid edits                           | invalid external edits retain the last good values, report diagnostics and block writes |
| Stop cancelling replaced debounce timers                         | a watcher burst produces one diagnostic after its debounce boundary                     |
| Notify shadowed subscriptions without effective-value comparison | subscriptions ignore unrelated keys, unchanged assignments and shadowed changes         |
| Disable recursive secret guards                                  | secret-looking fields and values are rejected without echoing their contents            |
| Remove the client blob cap                                       | oversized blobs, invalid values and future documents do not replace valid settings      |
| Ignore provenance when comparing notifications                   | file deletion reports a provenance change even when the fallback value is equal         |
| Publish destination before writing instead of atomic rename      | ace rereads earlier external edits and the last rename wins without torn files          |
