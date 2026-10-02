# Bound diagnostic admission before root discovery

Status: open follow-up from [PR #38](https://github.com/arpan404/ace/pull/38).
Owners: core decision logic and the engine/daemon storage boundary.

The review measured 1,168,546 serialized state bytes after 1,000 rejected facts
with 1 KiB bodies before root discovery. The first valid root flushed 1,004
events. These are historical review measurements, not new execution results.
`pendingNotices` still retains full diagnostic data without an admission limit.

## Required contract

Core must remain pure. Introduce an explicit diagnostic admission result or
caller-supplied storage reference independent of an agent owner. The caller
stores raw evidence before core admits bounded notice metadata. Keep unknown
provider evidence available under a documented storage/retention bound, rather
than silently truncating the current verbatim-data contract.

Pending metadata needs both a count cap and a serialized byte cap. Count alone
cannot bound a single oversized fact. A proposed starting budget is 64 notices
and 64 KiB of metadata per thread, with at most a 2 KiB preview per notice.
These values are proposals for the follow-up, not changes to the current API.

Coalesce overflow into one bounded notice carrying the omitted count and the
storage references needed to inspect admitted raw evidence. Define what happens
when diagnostic storage itself is full, and make that condition explicit to the
caller. Avoid per-fact scans of the retained queue. Bound work when the first
root appears so malformed input cannot monopolize a thread actor.

The engine/daemon owns raw storage, retention and backpressure. Persist pending
metadata and raw references with the thread state so restarts cannot orphan or
lose the admitted evidence. Preserve the original timestamps and attach the
notices to the first actual root, without creating a diagnostics-only agent.

## Acceptance criteria

Write public-API behaviour tests for sustained pre-root rejection, one oversized
fact, mixed rejection reasons, exact count/byte boundaries, overflow coalescing,
full storage, root initialization and restart recovery. Assert bounded retained
metadata and bounded initialization events alongside raw-evidence retrieval.
Use a real temporary store at the caller boundary and injected clocks/IDs.

Add a non-gating admission/flush benchmark that records byte counts, event
counts and peak resident memory at growing input sizes. Test and benchmark
execution is reserved for merge under the owner rule.
