# 0071: Cross-device agent delegation

Status: proposed. Date: 2026-10-09.

## Decision

Agents use `ace_device_list` to discover connected paired hosts and their actual
projects, models, accounts and native permission modes. `ace_device_delegate`
requires an explicit host and project. It creates one independent task on that
host, with stable source host, parent thread, parent agent and target thread
identities. It does not broadcast a prompt or change the parent's environment.

The originating daemon owns a durable SQLite task ledger and an ace-owned parent
background dependency. The client brokers target control through its existing
MachinePool workers. A short authenticated broker lease permits one client at a
time; host credentials remain in client-owned secret storage. The broker renews
its lease independently of physical preparation. A replacement client queries
the target's canonical receipt/status before repeating admission. Admission,
interrupt and context upload ownership belong to the task, not that window.

Remote children count toward the same root usage, duration, child and concurrency
budgets as local children. Native permission policies retain their exact identity
when both devices use the same provider. Different providers require an advertised
low-risk native mode. Parent Stop, policy change, deletion and deadline expiry
fence future admission. A dispatched cancellation remains pending until the target
confirms it has stopped and owned physical preparation/cleanup has completed.
A disconnected device is unavailable; it is never reported as completed.

## Context and files

Every task includes a bounded read-only parent transcript snapshot with explicit
source host/thread provenance. An agent may select existing thread attachment
hashes and relative workspace files. The source confines file reads to that
thread's actual filesystem/worktree, then freezes bytes as immutable attachments.
Each file is limited to 32 MiB; the task is limited to 128 MiB and 16 attachments.
No credentials or complete provider configuration are included in the snapshot.

The existing encrypted files relay imports the manifest and bytes into a task-owned
target draft. It pins both the relay key and authenticated target host identity.
Each 64 KiB chunk is acknowledged; retries resume durable offsets and hashes are
verified before provider admission. Uploads and late start attempts consult the
same cancellation fence. Receiving providers resolve adopted attachments to paths
on their own device. Source absolute paths are never interpreted on the target.

Main conversation and task control retain the direct/Tailscale MachinePool route
from ADR0059 and ADR0070. This change adds no relay pairing/conversation transport.
A connected client and configured target files relay are required. Result text is
bounded and delivered to the originating agent once, or returned directly to an
active waiter.

A receiving root agent can call `ace_device_task_publish` once before finishing.
It explicitly selects thread attachment hashes or relative workspace files under
its current task authority. The target freezes these bytes with the same bounds
and seals their immutable manifest together with the canonical terminal outcome.
Selected names and aliases retain producing host/thread/path provenance. Further
turns or changed workspace files cannot mutate that sealed outcome.

The broker reads only sealed selected hashes over the target's encrypted files
relay and imports them into the originating parent thread. A shared acknowledged
64 KiB pump resumes offsets after disconnect. Source completion normally requires every
selected output to be committed; after bounded import retries the sealed text
is delivered with an explicit unavailable-files warning. Missing or changed manifests cannot replace an
already bound selection. `ace_device_task_wait` and status expose source-local
resolved paths alongside producing-device provenance, and background results
carry actual parent-owned attachments. Foreign filesystem paths are never used
as local paths. Workspace copying, automatic overwrite and Git merging remain
separate operations.

Stop drops temporary output retention and durably records unfinished owned uploads
for bounded cancellation cleanup at startup, during maintenance and shutdown.
Transient cleanup failures retry without removing pre-existing attachment refs.
Delivered terminal rows expire after seven days once their root is idle; deleting
the owner also releases them. Active and undelivered rows remain retained.
Cancellation without target acknowledgement fails after thirty seconds and
explicitly warns that the remote task may still be running. Sealed results survive
cancellation and failed imports. Result text is bounded to 4,096 UTF-16 units and
truncation propagates through the broker. Both devices need this protocol version; an older target lacking a
sealed manifest is reported unavailable rather than treated as a completed task.

Remote task roots and their local descendants cannot recursively delegate to a
third device. This keeps parent budgets, cancellation ownership and the current
context scope enforceable without a distributed ancestry protocol.

## Verification

Scripted provider tests exercise two real daemons and the encrypted relay with
image bytes, immutable selected file bytes, source provenance, scoped reads,
missing context, repeated admission, cancellation and relay disconnects. Owner
tests cover durable identity, broker replacement, provider exit, policy changes,
concurrent waiters, Stop during context preparation and offline deadlines. Client
broker tests cover recovery without duplicate uploads and authority revalidation
after transfer. Reverse-sharing tests exercise a real target MCP publication,
PNG/text bytes, aliases, immutable outcomes, source-local resolution, partial
reconnect, manifest downgrade rejection and Stop during upload admission with
transient cancellation failure followed by recovered cleanup. No real provider
prompts are used.
