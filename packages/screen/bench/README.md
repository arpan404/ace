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
