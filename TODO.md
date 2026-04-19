# TODO

## Small things

- [ ] Submitting new messages should scroll to bottom
- [ ] Only show last 10 threads for a given project
- [ ] Thread archiving
- [ ] New projects should go on top
- [ ] Projects should be sorted by latest thread update

## Bigger things

- [ ] Queueing messages

## Session handoff

- [ ] 2026-04-18: Workspace editor cross-file LSP navigation is still not working reliably. `cmd`-click/F12 and cross-file type jumps are still failing in the Monaco editor even after wiring definition/reference RPCs through the stack.
- [ ] Keep the flatter, cardless workspace header treatment from the latest editor chrome pass.
- [ ] Next session: trace the live runtime path end-to-end in the browser and server. Confirm whether definition RPC calls are actually firing, whether the server returns locations for the active workspace/worktree, and whether Monaco click events are being intercepted or overridden before navigation runs.
