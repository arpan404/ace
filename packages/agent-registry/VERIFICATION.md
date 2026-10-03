# ACP registry verification

Status: static review only. All tests, benchmarks and mutation cases below are **not executed (tests run at merge)**. No provider probes, sessions, prompts or recordings were run. The upstream schema/format and dependency manifests were read as primary-source metadata; fetching those documents is not provider execution. The canonical CDN refresh attempted during implementation returned HTTP 403, so no current production catalog refresh is claimed.

## Behavior coverage to run at merge

- `decode.test.ts`: unknown fields/distributions remain raw; future majors, duplicate IDs and entry/response overflow reject refresh.
- `decode.test.ts`: target/path/version restrictions prevent executable plans; digest changes with distribution changes.
- `catalog.process.test.ts`: real local HTTP/cache edges retain stale data after offline restart, malformed/oversized responses and failed refresh; single flight and ETag are observable.
- `catalog.process.test.ts`: custom sources get distinct identity and cannot acquire official profile labels.
- `install.process.test.ts`: listing/planning does not download; a hash mismatch never publishes an installation.
- `install.process.test.ts`: changed versions require new consent; cancellation cleans staging and preserves prior approved artifacts.
- `install.process.test.ts`: approved artifacts persist across restart; replacement or agent impersonation prevents launch.
- `install.process.test.ts`: bridge launch always selects the user-owned Claude/Codex binary and home; missing/replaced native binaries fail.
- `install.process.test.ts`: a synthetic npm manager installs exact metadata and contributes its real lock integrity to the result.
- `archive.process.test.ts`: regular gzip tar entries install; absolute/traversal paths and symlinks cannot publish or escape the private root.
- `adapter-acp/negotiation.process.test.ts`: resume follows initialize; actual config IDs and dependent replacement choices govern selectors; Gemini uses the supported legacy dialect.
- `adapter-acp/negotiation.process.test.ts`: old Qwen restrictions override even optimistic live claims.
- `adapter-acp/negotiation.process.test.ts`: MCP follows HTTP advertisement, preserves configured servers, rejects name collisions and revokes leases after startup failure.
- `adapter-acp/negotiation.process.test.ts`: lease echoes are absent from raw frames and session metadata; unknown updates/vendor requests survive; final shutdown facts drain after normal and fault shutdown.
- `adapter-acp/negotiation.process.test.ts`: an incoming permission flood stops the owned process instead of growing the wait set.
- Existing ACP process/replay and core lifecycle suites retain their child/approval/shell settlement assertions. Existing provider-kit process suites retain multibyte framing, stalled writes, pending/ID bounds and replacement isolation coverage.
- `models/registry.test.ts`: generic listing/refresh never spawns; two agents/homes preserve native model IDs and separate login/installation generations.
- `models/registry.test.ts`: session writes serialize dependent replacements, and shutdown waits for active persistence. Pending login-deletion ordering also needs execution and targeted review at merge.
- `mcp-server/stdio-bridge.process.test.ts`: real stdio/loopback MCP calls retain caller scope; revoked leases deny old bridge calls; bearer material is absent from argv.
- `daemon/acp-identity.process.test.ts`: two thread identities and effective support survive ordinary events and SQLite restart.
- `daemon/agent-registry.server.process.test.ts`: read scope lists metadata; unauthorized refresh and installation controls fail before mutation.
- `client/registry.process.test.ts`: correlated registry metadata replies resolve without entering durable command intents.

## Planned production mutations

Each case is designed to be killed by the named behavior test. No mutation was applied or executed under the owner policy.

| Mutation                                                             | Expected failing behavior                                        |
| -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Drop unknown distribution/entry fields during decoding               | raw preservation in `decode.test.ts`                             |
| Accept a future registry schema major or ignore entry byte bounds    | rejected refresh in `decode.test.ts`                             |
| Erase the last valid snapshot before a failed refresh                | offline/stale catalog in `catalog.process.test.ts`               |
| Treat custom-source IDs as official profile IDs                      | source-qualified identity in `catalog.process.test.ts`           |
| Remove binary SHA-256 comparison                                     | no publication after mismatch in `install.process.test.ts`       |
| Skip the catalog digest check on install intent                      | new consent after changed version in `install.process.test.ts`   |
| Keep a cancelled private installation directory                      | cleanup/prior artifact preservation in `install.process.test.ts` |
| Remove executable fingerprint validation                             | replacement rejection in `install.process.test.ts`               |
| Allow bridge environment to override the selected native CLI         | user-binary guarantee in `install.process.test.ts`               |
| Follow archive symlinks or omit traversal containment                | archive escape rejection in `archive.process.test.ts`            |
| Hard-code `configId: "model"`                                        | actual selector ID in `negotiation.process.test.ts`              |
| Ignore dependent config-option replacements                          | removed-choice rejection in `negotiation.process.test.ts`        |
| Restore unconditional session/load or ignore old-Qwen profile limits | negotiated resume/restrictions in `negotiation.process.test.ts`  |
| Remove lease redaction or cleanup on start failure                   | raw secrecy/lease revocation in `negotiation.process.test.ts`    |
| Dispose stdout observation when rejecting requests after a flood     | final fault-shutdown fact in `negotiation.process.test.ts`       |
| Remove incoming request admission cap                                | owned-process flood termination in `negotiation.process.test.ts` |
| Restore generic empty-session discovery                              | no process/session metadata refresh in `models/registry.test.ts` |
| Key ACP models only by login revision                                | agent/installation separation in `models/registry.test.ts`       |
| Remove install admin/operate authorization                           | authenticated wire scope test                                    |

## Performance evidence deferred

`bench/catalog.ts` defines indexed lookup, decoding and bounded stream workloads. `adapter-acp/bench/redaction.ts` defines unchanged and redacted frame workloads. `mcp-server/bench/stdio.ts` defines bridge forwarding with a synthetic fetch boundary. Each reports throughput and peak RSS, without a gating threshold. Numbers are **not measured** because benchmark execution is forbidden during this task. Run only at the owner-authorized verification gate.

ZIP extraction, real npm/uv package behavior, Windows launch, actual provider account homes/keychains, provider MCP preservation and turn-level profile fidelity need further runtime evidence. The source profiles do not claim those behaviors as verified. Package integrity evidence is not a signed-registry badge.

## Static development evidence

`bun run fmt`, `bun run lint`, `bun run typecheck` and `bun run check:size` passed on this candidate. The size check included the new files: 1,345 tracked source paths, all below 1,500 lines. `git diff --check` passed. No test, benchmark, mutation, probe or recorder command was executed; `bun run check` is deferred because it includes tests.
