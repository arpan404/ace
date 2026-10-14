---
name: plan-and-delegate
description: Split a larger task into independent parts, run them in parallel child threads on any provider, then check and combine the results. Use when work has parts that don't depend on each other, or the person asks to parallelize or delegate.
---

# Plan, then delegate

1. Read the situation in one call: `ace_context` with `topics: ["recent", "notes", "changes"]`. Someone may already have done part of the work.
2. Plan the parts. Delegate only parts that are independent, fully specified and verifiable. Keep the rest, and anything that needs the person, for yourself.
3. Start the children with **one** `delegate_task` call: `tasks: [{ requestId, task, role, provider }, ...]` with `await: "all"` and a `timeoutSeconds`. Write each task so that it stands alone: goal, files, constraints, project notes that apply, and how to verify. Use stable requestIds so a retry creates nothing new.
4. Handle the result:
   - `ready`: check every child's result against its task.
   - `needs_you`: tell the person what each child asks.
   - `timeout`: call `ace_wait` with the remaining ids.
   - Never poll `ace_agents_status` in a loop.
5. Verify the combined work yourself (tests, a browser check for UI) before you call it done. A child that failed or was cancelled is not done.
