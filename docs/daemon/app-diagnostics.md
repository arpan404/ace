# Diagnostics from the app

Settings › Advanced runs the same read-only doctor registry as `ace doctor` and exports the
same redacted archive format as `ace support-bundle`. Neither action starts a CLI subprocess
for the ace command. Setup and Devices read toolchain hints from the connected computer, so
browser and remote clients see that computer's Git, Xcode and Android SDK availability.

`diagnostics.request` takes `operation: "doctor" | "toolchains"` and a request ID. Its
`diagnostics.result` returns a report, toolchains or a fixed error. Requests require read
scope, bypass command receipts and share at most one pending operation per socket. The host
coalesces concurrent probes across clients and support exports. The connected report omits
the offline port-availability check because the running server owns that port.

Support export uses the existing pull-based file channel. Send `files.request` with
`scope: "support"` and `operation: {op: "artifact.support", includeThreads: false}`. Download
the returned artifact ID with `artifact.download` in the same support scope. This registry is
separate from workspace files and works before adding a project. It exposes only support
creation and artifact download. Legacy workspace requests retain their existing behavior.
Default export requires read scope. Conversation opt-in and downloads of those archives
require the local host token with operate scope; paired devices cannot request or download
archives containing conversations from other threads. This policy also applies to relay
file channels. The archive is never uploaded automatically.

The existing diagnostics writer bounds input to 64 MiB and compressed output to 16 MiB,
redacts before staging or durable writes, and excludes credential files, databases and raw
environment dumps. The browser pulls 64 KiB chunks with backpressure and retains at most
16 MiB for its download Blob. Files inherit artifact quotas and retention. Cancelling the
dialog aborts client requests; an abandoned export cannot publish after the socket loses
authority.

Skill source reads assemble UTF-8 pages against one accepted hash, bounded to the plugin
file limit of 4 MiB. Editing retains the existing 256 KiB limit. `plugins.edit` prepares a
review against the source hash; saving never activates an edited version. The shared trust
review accepts its exact commit and content hash through `plugins.accept`. Back, closing the
review and leaving the page cancel pending reviews. A changed source keeps the draft and
offers reload instead of overwriting the accepted file.
