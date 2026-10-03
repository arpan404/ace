# Daemon startup regression review

Validation is static only under the owner's merge-only execution rule. No tests,
benchmarks, mutation runs, daemon reproductions or doctor probes were executed.
Runtime outcomes and baseline failure claims need run at merge.

The source entry point is `node apps/daemon/src/cli.ts start`, also exposed through
`bun run --filter @ace/daemon dev`. The root package has no `daemon` script.
Reproductions should use an isolated `ACE_HOME`, port zero and an outer deadline.
The process regressions use the source CLI directly, preserving worker entry URLs.

## Source findings

On the branch's starting main, `apps/daemon/src/index.ts:130` awaits every
listener hook before writing the endpoint at line 132.
`apps/daemon/src/services/notifications.ts:21` awaits notification start, which
at `apps/daemon/src/notifications.ts:49` awaits `attached.tick()`. That tick
awaits worker cursor RPC, finite replay, and then delivery at
`packages/notify/src/service.ts:205`. Worker RPCs have no readiness handshake or
startup cancellation. Neither factory composition nor activation has a named
bound or degraded outcome.

This establishes an unbounded startup dependency chain and an endpoint withheld
by feature activation. It does **not** establish why the reported first cursor
RPC stalls on an empty store. Empty replay and empty delivery are finite by
source inspection. Confirm the runtime-specific trigger at merge, including
whether the report used Node via Bun scripts or Bun as the runtime. The fix removes
feature startup from core endpoint readiness and makes any such worker stall
observable and cancellable; the healthy-source test requires notifications to
actually become ready, so simply degrading every worker cannot pass it.

Doctor's original `packages/diagnostics/src/probes.ts:67` requires the entire
version string to match `git version [\\w.+-]+`, rejecting the Apple Git suffix.
Line 60 searches only PATH. Neither outcome proves git is absent from the machine.

## Behaviour tests and mutation cases

All cases below are **not executed (tests run at merge)**.

| Test                                                                                                                                                                    | Mutation cases it is designed to kill                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startup.process.test.ts`: fresh source home publishes an endpoint, opens an authenticated WebSocket, has empty history and ready notifications/engine, then shuts down | Withhold the endpoint; await a lifetime loop; publish a false ready marker; always degrade notifications; leave an endpoint after shutdown                                                |
| `startup.process.test.ts`: unresponsive notification worker                                                                                                             | Withhold endpoint until feature startup; remove the named deadline; report the wrong service; publish an uninitialized worker; fail the whole daemon; leak the aborted worker on shutdown |
| `notifications-readiness.process.test.ts`: offline delivery remains pending after readiness                                                                             | Await delivery as readiness; lose durable replay coverage                                                                                                                                 |
| `startup.process.test.ts`: unresponsive engine discovery                                                                                                                | Bound only notifications; report a stalled engine as ready; drop the read-only fallback; accept commands without an engine                                                                |
| `doctor-git.process.test.ts`: empty PATH                                                                                                                                | Remove system-location fallback; resolve only via inherited shell PATH                                                                                                                    |
| `doctor-git.process.test.ts`: Apple Git suffix                                                                                                                          | Reinstate the end-anchored suffix-free version matcher; reject a working explicit installation                                                                                            |
| `doctor-git.process.test.ts`: unrelated version output                                                                                                                  | Accept any successful executable as git                                                                                                                                                   |

Existing doctor failure tests now install an explicit failing git executable.
Their previous empty-PATH assumption was incompatible with system git fallback.
The unrelated-version rejection is additional coverage; main's matcher already
rejects that output by source inspection. The regression cases for fallback and Apple Git reject main's behaviour by source
inspection. Baseline runtime failures still need run at merge.
