# 0221: Prepare iPhone transcript Markdown before drawing

Status: proposed. Date: 2026-11-23.

## Context

An older history page can bring dozens of finished answers into the native feed. Markit can parse
and highlight up to 64 KiB synchronously on the first render of each view. The feed also needs a
height to place that view. Keeping rendered views helps when a row scrolls out and back, but the
window releases those views when it evicts their rows.

## Decision

1. **Prepare finished answer prose and code on a per-thread actor.** Start when history item
   patches arrive, while the page is still held. Visible answers share the same actor and look
   up prepared documents by dialect and content hash. The cache keeps at most 64 documents
   and 4 MiB of estimated content. The streaming renderer still applies incremental updates.
2. **Keep UIKit layout on the main actor.** A cached document can be installed at first layout.
   A cold answer waits for its document and uses a prior measurement if one exists at this
   width and text size. SwiftUI owns the layout outside the Markdown view.

## Consequences

Cold content can still change height when its document arrives. Split tables, images, diagrams,
and outer row layout have their own sizing paths. Existing page holds and end anchors continue
to apply. The 120 Hz device gate will show whether the feed also needs explicit row sizing and
view reuse in a collection view.
