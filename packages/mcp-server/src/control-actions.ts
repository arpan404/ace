import type { AgentControlOperation } from "@ace/protocol";

type Action = {
  description: string;
  riskClass: "read-only" | "thread-write" | "agent-execution" | "external-effect";
  /**
   * Overwrites work or commits future spending. These alone ask the person through the provider;
   * everything else is governed by the thread's permissions and ace's own consent.
   */
  destructive?: true;
};
/** Shared by advertised tools and the daemon's approval attribution. */
export const controlActions: Record<AgentControlOperation["op"], Action> = {
  "threads.list": {
    description:
      "List or search ordinary and child threads in the calling thread's project. Page with the returned cursor; unrelated projects are forbidden.",
    riskClass: "read-only",
  },
  "thread.start": {
    description:
      "Start an ordinary top-level conversation (a new thread in the person's sidebar) with explicit project/new-worktree/existing-worktree selection. `text` is sent as its first message and the new agent answers it at once, so write it as the opening request. It retains caller ownership and a permission ceiling, but has no child attachment or result wakeup. Use a stable requestId. Use delegate_task for child work. The person sees the new thread as a card with Open in this thread: relay the result's `summary` in a sentence and never list its ids.",
    riskClass: "agent-execution",
  },
  "thread.configure": {
    description:
      "Set an owned thread's catalog model and launch options, preserving provider/account and its permission ceiling. The engine applies the configuration through its existing model-switch lifecycle.",
    riskClass: "thread-write",
  },
  "agents.catalog": {
    description:
      "Page the composer's live provider/account/model catalog, model options and allowed native permission/runtime modes. Preserve instance when selecting an account. Stale or unknown authentication is explicit; no credentials or account homes are returned.",
    riskClass: "read-only",
  },
  "agent.status": {
    description: "Read an owned child's aggregate state, including descendants and human waits.",
    riskClass: "read-only",
  },
  "agent.result": {
    description:
      "Read an owned child's settled outcome. This does not consume its durable parent notification. Returns not_ready while any descendant or human wait remains active.",
    riskClass: "read-only",
  },
  "agent.message": {
    description:
      "Send follow-up work to the same owned child, retaining its permissions and delegation budget. Use a stable requestId.",
    riskClass: "agent-execution",
  },
  "agent.cancel": {
    description:
      "Cancel an owned child and all descendants. Acceptance is not proof that its tree has stopped; read status for settlement.",
    riskClass: "thread-write",
  },
  "device.task_publish": {
    description:
      "Publish selected owned attachment hashes or relative files from this remote task to its originating thread. One immutable selection per task, stable requestId, at most 16 items/128 MiB. No workspace overwrite or merge.",
    riskClass: "external-effect",
  },
  "device.list": {
    description:
      "List connected paired execution devices, their projects and available agents. Credentials and paths remain on their device.",
    riskClass: "read-only",
  },
  "device.delegate": {
    description:
      "Delegate a task to an explicitly selected paired device and project. Use a stable requestId. Returns a task ID; results return to this thread. Selected context is imported through the encrypted relay. Explicit published outputs return as originating-thread attachments; workspaces are not copied or merged.",
    riskClass: "agent-execution",
  },
  "device.task_status": {
    description: "Read an owned remote task's status, host/thread identity and bounded result.",
    riskClass: "read-only",
  },
  "device.task_wait": {
    description:
      "Wait for an owned remote task and its descendants to settle. Offline devices remain pending.",
    riskClass: "read-only",
  },
  "device.task_cancel": {
    description:
      "Cancel an owned remote task and its descendants, preserving cancellation until its device reconnects.",
    riskClass: "thread-write",
  },
  delegate_task: {
    description:
      "Delegate a task to a local child agent that inherits the parent's permission ceiling and delegation budget.",
    riskClass: "agent-execution",
  },
  "thread.create": {
    description: "Create a child thread in the caller's workspace without launching its provider.",
    riskClass: "thread-write",
  },
  "thread.launch": {
    description:
      "Launch a prepared child thread with the supplied task under its inherited permissions.",
    riskClass: "agent-execution",
  },
  "thread.message": {
    description:
      "Send to an owned thread under its existing permissions. queue waits for settlement, steer uses the provider's native steering or queue fallback, and restart atomically accepts a cascade interrupt followed by queued replacement input. Stable request IDs deduplicate the whole restart.",
    riskClass: "agent-execution",
  },
  "thread.wait": {
    description: "Wait for an authorized thread's tree to settle and read its result.",
    riskClass: "read-only",
  },
  "thread.read": {
    description: "Read an authorized thread's metadata and a bounded retained transcript page.",
    riskClass: "read-only",
  },
  "thread.read_output": {
    description: "Read a bounded byte range of retained output belonging to an authorized thread.",
    riskClass: "read-only",
  },
  "thread.search": {
    description: "Search an authorized thread's retained transcript without changing it.",
    riskClass: "read-only",
  },
  "thread.interrupt": {
    description: "Interrupt an owned thread and its descendants.",
    riskClass: "thread-write",
  },
  "thread.fork": {
    description: "Create an independent fork of an owned thread's conversation.",
    riskClass: "thread-write",
  },
  "thread.merge": {
    description: "Merge an owned thread's work through its workspace owner.",
    riskClass: "external-effect",
    destructive: true,
  },
  "queue.edit": {
    description: "Replace queued input on an owned thread before it is delivered.",
    riskClass: "thread-write",
  },
  "queue.reorder": {
    description: "Reorder pending input on an owned thread.",
    riskClass: "thread-write",
  },
  "question.answer": {
    description:
      "Answer a pending question on an owned thread. Permission approvals cannot be answered.",
    riskClass: "thread-write",
  },
  "thread.rename": {
    description: "Change an owned thread's display title.",
    riskClass: "thread-write",
  },
  "thread.regenerate_title": {
    description: "Generate an owned thread's display title from retained user input.",
    riskClass: "thread-write",
  },
  "thread.link_pr": {
    description:
      "Link a pull request to your calling thread using its URL or number. The repo defaults to the thread workspace's origin remote; repo may be owner/name or host/owner/name. Existing links are unchanged. If the forge is offline or signed out, save an unverified link and refresh it later.",
    riskClass: "thread-write",
  },
  "thread.unlink_pr": {
    description:
      "Unlink a pull request from your calling thread using its URL or number, or all: true to remove every link. This only changes the thread's links; it does not change or close the pull requests.",
    riskClass: "thread-write",
  },
  "thread.list_prs": {
    description:
      "List your calling thread's linked pull requests, newest first, with their number, repository, URL, state and title.",
    riskClass: "read-only",
  },
  "thread.settle": {
    description: "Archive an owned thread only after its work has settled.",
    riskClass: "thread-write",
  },
  "thread.snooze": {
    description: "Snooze notifications for an owned thread until the supplied time.",
    riskClass: "thread-write",
  },
  "automation.manage": {
    description: "Create, change or run a local automation and its future agent work.",
    riskClass: "external-effect",
    destructive: true,
  },
  "project.read": {
    description: "Read the caller's workspace project metadata.",
    riskClass: "read-only",
  },
  "project.rename": {
    description: "Change the caller's workspace project display name.",
    riskClass: "thread-write",
  },
  "thread.handoff": {
    description: "Prepare a Git worktree and hand off an owned thread's conversation to it.",
    riskClass: "external-effect",
    destructive: true,
  },
  "preview.list": {
    description: "List preview servers associated with an authorized thread.",
    riskClass: "read-only",
  },
  "preview.close": {
    description: "Stop a preview server associated with an owned thread.",
    riskClass: "thread-write",
  },
};
