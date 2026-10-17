---
name: offshift
description: Own a multi-step coding outcome through verified delivery when the user asks for Offshift or end-to-end execution.
---

# Offshift

Use `ace_offshift` to retain the outcome and evidence in ace. If the tool is absent
from your list, first call `ace_guide` with `topic: "offshift"` to reveal it. Execute work through
existing provider tools and ace's agent, browser and thread tools. The record
survives restart; continuation depends on the host's actual wake or scheduling
mechanism.

## Start or resume

Read the user's authorized endpoint and repository instructions. For an existing
assignment, call with `request: {action: "list"}`, then `get` its run. Resume from
its phase, blocker and evidence. Preserve user decisions across turns.

For a new substantial assignment, call with:

```json
{
  "request": {
    "action": "start",
    "runId": "feature-name",
    "requestId": "start-feature-name",
    "outcome": "Observable result",
    "endpoint": "Verified local changes",
    "criteria": [
      {
        "id": "behavior",
        "description": "Specific user-visible behavior",
        "requiredKinds": ["automated", "source"]
      }
    ]
  }
}
```

Choose evidence kinds needed to establish each criterion. UI behavior requires UI
evidence when repository/user instructions require it. An inaccessible requirement
stays pending with a concrete blocker. The endpoint records authorization; a record
cannot grant publication, spending or permission to message other people.

## Execute and verify

Every mutation after start needs `runId`, a fresh stable `requestId`, and the last
returned `version`. Retry the identical payload after a lost response. On a version
conflict, get the current run and reconcile before submitting a new request.

Advance one phase at a time with `action: "advance"`, `phase` and a concrete `note`.
The sequence is `plan`, `implement`, `verify`, `review`, `delivery`. Return to an
earlier phase for repairs. Delegate through `delegate_task` only when authorized
and useful; inspect results and wait through `ace_wait`. Existing ace tools own
provider execution, workspace changes and child cancellation.

Before verification, `get` the run and retain its `revision`. Perform the actual
check, save evidence, then submit:

```json
{
  "request": {
    "action": "evidence",
    "runId": "feature-name",
    "requestId": "check-behavior-1",
    "version": 2,
    "evidence": {
      "criterionId": "behavior",
      "kind": "automated",
      "result": "pass",
      "revision": "REVISION_FROM_GET",
      "action": "Actual command or interaction performed",
      "artifact": "Retained report reference",
      "note": "Observed result and environment"
    }
  }
}
```

Evidence kinds are `automated`, `source`, `ui`, `human`, `manual`. Each required
kind needs a current pass. A failed observation replaces its earlier pass. If
source changes during a check, repeat it at the new revision. Keep summaries
concise and raw output in artifacts. Record unverified requirements honestly.

Use `action: "block"` and `note` for a missing decision or unavailable access.
Resolve the actual blocker, then `resume` with the decision and source in `note`.
Neither operation pauses or resumes provider processes. User pause/cancel requests
must also use the host's native execution controls.

## Deliver

Review the combined diff and rerun affected checks after repairs. Advance to
`delivery` only when every criterion has current passing evidence. `waiting_on_tree`
means evidence is ready but the owner or a descendant is still active. Completion
is observed only once the whole tree is done; a human wait also prevents completion.

Report the outcome, checks performed, and material gaps. A status question preserves
the assignment. Keep working within authorization until the outcome is verified or
a concrete blocker prevents progress. Never describe a workflow record as a running
background agent.
