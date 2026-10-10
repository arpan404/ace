import type { AgentControlOperation } from "@ace/protocol";

type Action = {
  description: string;
  riskClass: "read-only" | "thread-write" | "agent-execution" | "external-effect";
};
/** Shared by advertised tools and the daemon's approval attribution. */
export const controlActions: Record<AgentControlOperation["op"], Action> = {
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
    description: "Send follow-up work to an owned thread under its existing permissions.",
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
