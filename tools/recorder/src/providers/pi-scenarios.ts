/** Approval-ready recipes, intentionally not wired into the quota-spending recorder CLI. */
export const PI_SCENARIOS = [
  {
    id: "tool-read",
    requires: "stock Pi",
    steps: [
      "Start RPC in the recorder's synthetic workspace",
      "Submit the approved tool-read prompt",
      "Capture text/thinking, tool start/end, entries and usage through agent_settled",
    ],
  },
  {
    id: "steer-and-queue",
    requires: "stock Pi",
    steps: [
      "Start an approved foreground shell turn",
      "Steer a second instruction during tool execution",
      "Queue a third instruction with followUp",
      "Assert agent_end does not settle while native queues remain",
    ],
  },
  {
    id: "retry-and-compaction",
    requires: "controlled provider failure approved separately",
    steps: [
      "Capture agent_end with willRetry",
      "Capture retry and overflow compaction continuation",
      "Assert only agent_settled closes the root run",
    ],
  },
  {
    id: "resume",
    requires: "stock Pi",
    steps: [
      "Complete a short approved turn and save get_state.sessionFile",
      "Close and switch_session using that file",
      "Submit the approved continuity question",
      "Capture native entry identifiers and settled boundary",
    ],
  },
  {
    id: "clone-and-fork",
    requires: "stock Pi",
    steps: [
      "Clone a finished active branch",
      "Fork before a selected user entry",
      "Verify original source remains intact and both native files resume",
      "Repeat with an explicit cancellation extension",
    ],
  },
  {
    id: "rollback",
    requires: "ace control extension",
    steps: [
      "Navigate before a user entry and after an assistant entry with summarize:false",
      "Capture explicit ace_rollback acknowledgement",
      "Verify abandoned entries remain in native tree and workspace files are untouched",
      "Close and reopen before another append; verify selected context and root rollback persist",
      "Clone after navigation to a branch with an assistant; restore source and resume clone with the same selected context",
      "Refuse root clone and fork before the first user; verify source remains live and resumes its selected context",
      "Repeat with cancellation",
    ],
  },
  {
    id: "extension-dialogs",
    requires: "reviewed synthetic dialog extension",
    steps: [
      "Issue select, confirm, input and multiline editor dialogs",
      "Answer and dismiss distinct native ids",
      "Issue a timed dialog alongside an untimed editor",
      "Assert fire-and-forget updates never block",
    ],
  },
  {
    id: "read-only",
    requires: "stock native tool allowlist",
    steps: [
      "Launch read,grep,find,ls with user extensions disabled",
      "Ask the approved prompt to attempt a file write and shell call",
      "Verify those tools are unavailable",
      "Verify supervised requests fail before launch",
    ],
  },
  {
    id: "ace-mcp",
    requires: "ace extension and scoped daemon lease",
    steps: [
      "Call ace read and notification tools",
      "Request one ace-owned child agent through the existing orchestrator",
      "Assert parent completion cannot settle a live child",
      "Revoke lease and verify further calls fail",
    ],
  },
  {
    id: "interrupt",
    requires: "stock Pi",
    steps: [
      "Run an approved foreground shell command",
      "Queue a native continuation",
      "Clear native queue, abort and abort_bash",
      "Assert no queued turn restarts",
    ],
  },
  {
    id: "exit-mid-dialog",
    requires: "stock Pi plus synthetic dialog extension",
    steps: [
      "Kill the owned fake or approved recorder Pi process with a dialog open",
      "Assert interaction expiry and failed process state",
      "Resume original file without resurrecting the old dialog",
    ],
  },
] as const;
