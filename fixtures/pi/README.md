# Pi fixtures awaiting approval

No real Pi fixtures have been recorded. No prompt was sent for this feature.
The approval-ready recipes are in
[pi-scenarios.ts](../../tools/recorder/src/providers/pi-scenarios.ts).
They are intentionally absent from the default recorder driver list.

Synthetic documented protocol frames live in
[the fake Pi process](../../packages/adapter-pi/src/testing/fake-pi.ts).
They are not recordings and make no claims about live-provider verification.
After owner approval, use a throwaway workspace, redact before committing and
write versioned checkpoints under `fixtures/pi/0.85.1` according to ADR 0005.
