# 0229: Spade parents own child requests

Status: Accepted. Date: 2026-11-24.

This decision replaces the person-facing lane routing, controls and request cards in
[ADR 0217](0217-spade-runs-each-task-in-its-own-lane.md). It amends the question and approval
rules in [ADR 0152](0152-spade-helpers.md), [ADR 0161](0161-spade-orchestration-trees.md) and
[ADR 0163](0163-spade-auto-review-only.md). The effect gate remains the authority under
[ADR 0171](0171-spade-decides-on-effects.md).

## Decision

The person talks to the bot in its main conversation. Lanes, helpers and worker bots created
for its work are private to their parent. Main reads every message, including replies to reports,
and forwards instructions with `task_message` or the corresponding child tool. Each lane still
owns its context, ask ledger and done check. Remove the person-facing lane endpoints. Retain the
ability to read historical routing events.

A question, approval, connect request or reviewer escalation from a child waits in the child
and gives its immediate parent a durable `child_ask` at the tail of its prompt. The request names
the child and supplies the question or the exact call and effect. The parent uses
`child_answer {ask, answer}` to answer a question and `child_decide {ask, decision, reason}`
to allow or deny a call. It answers from what it knows and asks the person only when it needs
their input.

A parent can allow a call only through its own permissions, grants and effect gate. Evaluate the
same bound call with the parent's mode and current trust state. Auto-review sends a decision to
the parent's reviewer wherever its gate calls for review. A child's launch restrictions also
hold. Refused effects, including access to credentials, stay refused.

If the parent's gate requires the person, the parent surfaces one request in its own conversation.
Payments, sending as the person and changes to access always take this path. The card describes
what will happen and why the bot needs it. It may include the task's purpose. A decision from
the person resolves that request and reaches the waiting child once.

Store the child wait and parent request together. Store the resolution and delivery together, keyed
by child, run and call. Pending requests are offered again after a restart. Roll up internal waits
as working. The person sees waiting status only once their answer is required. The bot cannot
settle while any descendant still has work.

## Implementation status

The first changes route direct messages and quoted replies through main and let parents answer
helpers' questions. The remaining request types, approval authority, lane endpoint removal and
tree-wide status are follow-up implementation work.
