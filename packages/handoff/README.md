# Portable conversation handoff

`selectHandoff(source, budgetBytes)` accepts at most 200 chronological item
previews and an authoritative total count. It prioritizes recent complete items,
restores chronology, and counts the UTF-8 bytes of its serialized manifest.
Budgets range from 2 KiB to 64 KiB. The daemon reads at most a 1 MiB item page.

Each excerpt cites a source thread and item. `omittedItems` includes history
outside the bounded page and items that do not fit. `history` describes an
`items.page` request from the original cutoff; output streams, raw data and
attachment details remain available through the existing history APIs. Excerpts
are explicitly partial context; provider-private working state is unavailable.

`renderHandoff` encodes the manifest as conversation data. Fork and provider
switch commands share this module. Cursor SDK portable fork integrations should
use the same API instead of maintaining another selection or budgeting policy.

Run `node packages/handoff/bench/selection.ts` only at merge time under the
current owner policy. The daemon also has a queued-switch stream benchmark in
`apps/daemon/bench/thread-transitions.ts`. Both report ops/s, microseconds per
operation and peak RSS. Measurements are not executed for this delivery.
