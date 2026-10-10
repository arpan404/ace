# ace real smoke

Commit: 13fe5f1d0d980bc1ba66f497169449a3e33f8530
Result: FAIL
Steps: 41; threads: 2; failures: 5

## Timings

- daemonStart: 14169 ms
- cold-start: 3769 ms
- catalogsReadySinceNavigation: 9199 ms
- catalogs-ready: 5489 ms
- past-sessions-scan: 119617 ms

## Failures

- bare-unavailable: Raw presentation data is visible (1 occurrence). Capture kept locally.
- refused-command: Smoke refused context.request.image.resolve (1 occurrence). Capture kept locally.
- step-failed: expect(received).toBe(expected) // Object.is equality (1 occurrence). Capture kept locally.
- step-failed: locator.hover: Timeout 15000ms exceeded. (1 occurrence). Capture kept locally.
- runner-failed: expect(received).toBe(expected) // Object.is equality (1 occurrence). Capture kept locally.

Full thread and history captures contain private conversation data and stay local. Only the requested Providers and Usage captures are attached here.

## Requested pages

- Providers and every provider page: completed without presentation findings.
- Usage: completed without presentation findings; captured from the main page to exclude private sidebar content.
- [Providers screenshot](real-providers.png)
- [Usage screenshot](real-usage.png)

The final catalog-settling check failed after the UI tour. Daemon idle RSS could not be recorded.
