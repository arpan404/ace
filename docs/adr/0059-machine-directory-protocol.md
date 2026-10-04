# 0059: Client-owned machine directory

Date: 2026-10-04. Status: accepted.

## Context

One desktop or browser window can connect to several of the user's daemons, such
as a laptop, desktop and dev server. Each daemon owns its projects, threads,
provider sessions and paired-device authorizations. Its paired-device list is a
list of authorized clients, not an inventory of the client's other machines.
Remote access and the encrypted relay already authorize access to one daemon.
ADR 0064's device channels retain that same host boundary.

## Decision

The client owns the machine directory. Each entry stores the daemon's stable
persisted `hostId`, a client-editable display name, a connection target and the
paired `deviceId`. A direct target contains a credential-free URL and optional
TLS fingerprint. A relay target contains a relay URL and ticket reference; the
reference identifies the platform's pinned relay connection configuration. It
is not a reusable ticket or device token. Directory version 1 is bounded to 100
machines and rejects duplicate host IDs, unknown fields and credentials embedded
in URLs. Directory metadata may participate in platform state sync; tokens may
never participate in it.

`MachineDirectory` injects metadata `Storage.load/save` and a
`MachineSecretStore.get/set/delete` interface. Secret keys encode the pair
`[hostId, deviceId]`. Desktop implements these three async operations in the main
process through the OS keychain. A narrow, origin-checked preload/IPC bridge
accepts a host/device key and a device token for set, returns a token for get,
and deletes that key for delete. The renderer cannot select a keychain service,
filesystem path or arbitrary credential. The service namespace belongs to ace;
main owns keychain errors and never logs values. This bridge is the desktop UI
workstream's next integration task. Web adapts its existing remembered-token
storage to the same interface; this remains browser-local authorization storage,
separate from directory JSON. Tokens cross worker messages only as volatile
connection configuration, never as persisted worker state. Existing durable
outboxes remain scoped to host and device by the worker bootstrap.

Pairing redeems a link or QR through the existing pinned access flow. The client
uses the issued device token to authenticate and read `host.identity`, then adds
the identity, target and device ID to the directory and stores the token in the
secret store. `MachineDirectory.pair` and `MachinePool.pair` inject this redeemer
so transport pinning and platform access adapters keep their current owner. A
manual URL uses the same authenticated identity read with an existing device
token. Replacing authorization requires removing the old entry and pairing
again. Removing a directory entry deletes its local token and closes its worker;
it does not revoke other devices or delete daemon data. Host-side revocation
remains the existing paired-device operation.

The proposed host-owned `machines.request/result` inventory is abandoned. Its
schemas remain deprecated for wire compatibility and return unsupported on
current daemons. Clients must not use it for discovery or status. Authenticated
`host.identity` requires read scope and returns only the current daemon's
`hostId`, display name and daemon version. `host.displayName` is a settings key;
an empty global value uses the operating system hostname. Workspace or thread
settings cannot change the identity response. Renaming a directory entry changes
the client's label; editing the host's global setting changes its identity name.
The daemon never contacts other hosts to answer this request.

## Runtime and isolation

`@ace/client-worker/machines` exports `MachinePool`; `@ace/client/machines`
exports the directory and merged thread store. These are separate entry points
for lazy import during multi-machine boot. Existing single-daemon imports and
`ClientApi` calls remain available unchanged. A pool with one configured entry
uses the same `RemoteClient` and underlying `Client` behaviour.

The platform's injected `spawn(entry, token)` creates a dedicated Worker or
SharedWorker for each host. The worker sets `ClientOptions.expectedHostId` to the directory host ID. The
client rejects a different welcome before replaying durable commands or
subscriptions, including the first connection after a process restart. Each
worker owns one `Client`, transport, reconnect
state, correlation maps, subscriptions, decode queue and host/device outbox.
The returned endpoint contains a port, volatile configuration and a synchronous
termination hook and an independent worker-failure observer. A worker exit
reports offline while retaining cached facts; `reconnect(hostId)` creates a fresh
worker from the stored authorization. Sharing one worker between different pool entries violates
this interface contract. A blocked worker can be terminated without awaiting
its message loop. Workers for different windows may share a host only when the
platform already scopes the SharedWorker to that host/device. Relay, files and
ADR 0064 device channels must also be selected by host, not by a window-global
endpoint.

Each connection reports `connecting`, `online`, `offline` or `auth_failed`.
`online` requires a ready authenticated connection and a successful identity
read matching the directory's host ID. Retry attempts report connecting;
network-offline hints and terminal non-auth failures report offline.
Authentication rejection or a mismatched identity reports auth_failed. Identity
request deadlines use the existing client's bounded request policy. No status
comes from another daemon's opinion, a relay's availability, or an elapsed stale
observation. Pool startup waits only for directory metadata, never for all hosts
to become reachable. Credential reads and worker startup run independently.
Disconnected hosts retain their last thread facts; disconnection cannot mark
agents done. Removing a host drops only its own rows.

Merged row keys encode `[hostId, threadId]`, so equal local IDs remain distinct.
Each row carries its machine entry and original daemon thread summary. Ordering
is stable by directory order, then daemon insertion order. The store consumes
sidebar change keys; row updates touch only changed rows. Membership updates
invalidate a lazily materialized ID list. Snapshots and host removal touch only
that host's rows. `observeChanges` supplies previous/current entries so rail and
Home counts can subtract and add contributions incrementally. `count(predicate)`
returns an observable count, initializing once and adjusting only changed rows.
The predicate comes from the existing client attention rule. The store does not
invent a second attention/status rule. UI consumers apply their existing rules
and initialize counts once from current rows before following changes.

Thread subscriptions and commands take a host/thread reference. Requests,
service subscriptions, controls and durable enqueue route through that
reference; mismatched top-level thread IDs are rejected. Cold reads and other
`ClientApi` families use `clientForThread(ref)`. Projects, accounts, terminals,
output IDs and other host-local resources use `client(hostId)`. New-thread
creation requires an explicit host ID. No operation falls back to another host
when a target is unavailable. The returned client retains its existing bounded
requests, cancellation, reconnect and subscription replay behaviour.

## ADR 0002

Directory secrets authorize the user's own ace daemon. They are device tokens,
not provider credentials. Provider execution and provider login stay on each
machine with the user's installed CLIs and the approved isolated SDK runtime.
This decision adds no hosted provider access or credential proxy.

## UI follow-up

Settings > Machines must add targets through pairing links, QR and URL/token
entry; rename and remove entries; and render live connection status. Rows and
thread headers need a machine badge. New thread needs an explicit machine
picker and per-machine projects/catalogs. Offline and auth-failed machines need
visible unavailable states and pairing recovery, while their cached agent facts
remain intact. Desktop must implement the main-process keychain bridge above.
The boot layer must lazy-load the pool and supply isolated worker endpoints,
host/device outbox storage and platform secret adapters. No UI components are
part of this runtime change.

## Verification

Public behaviour tests use three real worker threads with separate fake hosts,
colliding thread IDs and distinct account catalogs. They cover merge ordering,
create/send/read/subscribe routing, rename/removal, a blocked worker, offline
isolation, reconnect, auth rejection, metadata/secret round trips and the
unchanged direct single-client API. A real local daemon test covers authenticated
identity, hostname fallback and the global display-name setting. All test homes
are temporary. No provider sessions or recording tools are used.
