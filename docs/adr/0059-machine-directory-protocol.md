# 0059: Machine directory requires a client-owned design

Date: 2026-10-03. Status: proposed. Protocol only; no daemon directory implementation.

The remote-access ADRs define device authorization to one host and outbound relay transport. They do not define a shared inventory of other daemons. A host's paired-device list identifies clients authorized to that host, not other machines authorized to the current client. Reusing it as a machine directory would expose unrelated devices and invent reachability facts.

Add only an additive proposed wire contract. `machines.request` has paged `list` and single-host `status` operations. `machines.result` returns a bounded list, one machine or an explicit unavailable reason. A machine contains a stable host ID, display name, online/offline/unknown status and optional observation timestamp. It exposes no credentials, relay tickets, endpoints or filesystem paths. `Client.request` and the shared worker can carry the typed contract. No client should offer machine discovery until a directory owner is configured; current daemons return the existing unsupported service response.

Before implementation, decide where a client stores its approved daemon targets, how pairing authorizes each directory entry, which process observes reachability, and how stale observations become unknown. List visibility must be scoped to the requesting device. A client-owned directory may be preferable to a host-owned directory because the client pairs with multiple independent daemons. Relay availability alone cannot establish that a daemon is authenticated or reachable.

This feature stops at the protocol by the batch-2 request's explicit machines exception. A separate design must choose the directory owner and persistence before implementing list/status or fake machine inventory.
