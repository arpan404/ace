# Porting screen work to Rust

For builders whose work touches `@ace/screen` while the daemon moves to Rust. Read
[ADR 0225](../adr/0225-devices-screens-automations-and-the-mcp-server-move-to-rust.md) and
[behaviour.md](behaviour.md) first; behaviour.md §5 lists every test file by class. The engine's
[porting guide](../engine/porting-guide.md) sets the rules for daemon crates.

## What is ported: nothing in this plan

ADR 0225 keeps `@ace/screen` in TypeScript. The work is native already: capture, encoding,
accessibility, UI settle and input run in the macOS (Swift), Linux and Windows (Rust) helpers,
video goes to ace-media, and locked use is its own service. The TypeScript is orchestration:
120 to 251 µs of daemon CPU per computer-use call against a helper that takes tens to hundreds
of milliseconds, and its output (outlines, diffs, refusals, error text) is read by models and
people byte for byte. There is no work item, no switch and no Rust crate for this package.

Don't:

- port `computer/outline.ts`, `computer/policy.ts`, the wire decoders or the manager to Rust;
- start a Rust screen process or merge the helpers;
- change the helper wire (`hello`, `apps`, `resolve`, `state`, `act`, `cancel`) for a Rust caller.

## What builders of other phases do here

1. **ADR 0223 E2 (supervisor).** `ScreenManager`'s session helper and `Simulators` spawn through
   `@ace/provider-kit/process` in part (`helper.ts`, `simulator.ts`), so run the (a) process files
   with `ACE_SUPERVISOR=native` when E2 asks, one at a time:

   ```sh
   f=packages/screen/src/manager.process.test.ts
   test -f "$f" && ACE_STORE=native ACE_SUPERVISOR=native bun --bun x vitest run "$f" --maxWorkers=4
   ```

   `ComputerClient` spawns its helpers with `node:child_process` directly (`defaultSpawn`,
   `computer/client.ts:255`), so E2 doesn't cover them; ADR 0225 question 8 asks whether they
   should go through the supervisor.

2. **ADR 0225 M1 (native tools).** Screen tools are not a native family: they stay TypeScript
   handlers in the same registry. Run `mcp.process`, `tools.process` and
   `computer/toolkit.process` with `ACE_NATIVE_TOOLS` on for the first family to prove the
   registry still serves the screen tools unchanged.
3. **Never run a † file.** `identity.native.process`, `measurement.native.process`,
   `native.process`, `semantic.native.process`, `media-ingest.native.process`,
   `media-ingest.linux.process`, `computer/front.native.process` and
   `computer/background.native.process` drive the real helper against real windows or owned
   fixture apps (`ACE_SCREEN_INTEGRATION=1`, `ACE_COMPUTER_LIVE=1`); the owner runs them. Never run
   `bench/computer-actions.ts`, `computer-e2e.ts`, `computer-real-apps.ts`, `live-view.ts`,
   `interaction.ts`, `identity.ts` or `search.ts`: they operate apps on the Mac. The synthetic
   benches (`stream.ts`, `v2.ts`, `content.ts`, `control-output.ts`, `daemon-actions.ts`) and
   `computer/testing/world.ts` are safe.

## If the owner reopens the question

ADR 0225 reopens a port only on a measurement that shows a cost the language causes. If that
happens, the order is the one the tests make cheap, each behind its own switch and the
interface its (a) files already drive:

| Item | TypeScript replaced                                             | Interface kept                                            | Proof: (a) files                                                                 | (b) cases to move                                                       |
| ---- | --------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| S1   | `computer/outline.ts` (pure: outline lines, ids, diffs)         | `computerToolkit`'s results                               | `computer/toolkit.process`, `computer/linux.process`, `mcp.process`              | `computer/outline`                                                      |
| S2   | `computer/wire.ts` decoding and `computer/helper-connection.ts` | `ComputerClient.request`                                  | `computer/client.process`, `computer/timing.process`, `computer/toolkit.process` | `computer/helper-connection.process`, `computer/timing`                 |
| S3   | `policy.ts`, `computer/policy.ts`, `permission-model.ts`        | the refusals `computerToolkit` and `ScreenManager` return | `review-safety.process`, `manager.process`, `computer/toolkit.process`           | `policy`, `computer/policy-hosts`, `permission-model`, `public-failure` |

The rules of the engine's porting guide apply unchanged (one switch, one line; no new tests; no
parity harness; strings through `ace-json`; text a model reads stays TypeScript unless the item
proves it byte for byte).

## When you are done

- Report the screen (a) files you ran under your phase's switch, with their results, and
  anything in behaviour.md that turned out wrong, with the code that shows it.
- Commit and push as you go with `git push origin HEAD:refs/heads/<your-branch>`; never rebase or
  force-push. Every commit ends with exactly `Co-Authored-By: spade <bot@acehq.dev>`.
