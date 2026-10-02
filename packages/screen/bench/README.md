# Screen performance and mutation evidence

The owner now requires static review only: tests run once at merge. Do not run these benchmark or mutation scripts under the current rule.

`mutation-results.json`, `review-mutation-results.json` and `review-native-mutation-results.json` preserve historical results produced before that rule. All production mutations were reverted. They are not current-head validation results.

Current mutation cases are **not executed (tests run at merge)**. Public behavior tests are designed to kill:

- Removed default-off, app approval, controller ownership and Accessibility guards (`manager.test.ts`).
- Display input and an increased session cap (`manager.test.ts`).
- Missing initial takeover epoch check (`manager.test.ts`).
- Removed disable/revoke shutdown, premature indicator removal, publication before termination, missing startup indicator and premature startup-map removal (`shutdown.test.ts`).
- FIFO correlation and ignored injected deadlines (`helper.test.ts`).
- Removed pre-newline stdout/stderr cap (`output-limit.test.ts`).
- Oldest-frame retention, active unsubscribed viewers and increased header cap (`frames.test.ts`).
- Increased recording byte cap (`recording.test.ts`).
- Advertised 8192-character text (`tools.test.ts`).
- Black JPEGs, no-op window input and permitted overlapping-window input (`native.test.ts`).

Each runtime outcome **needs run at merge**. The PR description maps review mutation numbers to these cases and records historical benchmark numbers, workload sizes, dropped-frame semantics and RSS. No new measurement is claimed under the static-only rule.

V2 mutation cases are also **not executed (tests run at merge)**:

- Silently downgrade malformed capabilities or omit hello negotiation (`v2.test.ts`).
- Spawn a helper per semantic action or inspection (`v2.test.ts`, 100 observable actions and owned process count).
- Retain native capture after the last viewer or after a failed sink (`v2.test.ts`).
- Enqueue one capture command per rapid subscribe/unsubscribe (`v2.test.ts`, 256 synchronous viewer changes).
- Lose the owned process handle on failure and hide the indicator before cleanup (`v2.test.ts`).
- Ignore total tree node/depth limits (`v2.test.ts`, adversarial helper replies).
- Regenerate refs across capture stop, stub AX press, leak secure values or allow secure-field semantic input (`semantic.native.test.ts`).
- Encode idle/empty damage, ignore missing-signal content changes, or omit initial lease snapshots (`Tests/FrameChangesTests.swift`).
- Rebuild/re-sign unchanged executable bytes (`semantic.native.test.ts`, executable inode/mtime/hash).
- Overwrite a stable installed executable or ignore its manifest hash (`install.test.ts`).
- Retain capture after recording quota while artifact publication stalls (`recording.test.ts`).

`native-runtime.ts` is instrumentation for merge-time measurement. It reports idle CPU, CPU at 10 fps, delivered/encoded frame counts, mean encoding latency, cold/cached Finder `ui.tree` median/p95, and peak RSS. It never builds a helper or launches a process per action. All v2 numbers **need run at merge**; historical v1 archives are not a Codex comparison.
