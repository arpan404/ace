/** No scenario in this file is recording authorization. Owner approval is per scenario. */
export const cursorSdkScenarios = [
  {
    id: "text-thinking-read",
    prompt: "Read src/math.ts. Explain its exports in one sentence; do not edit.",
  },
  {
    id: "edit-shell-results",
    prompt:
      "Add subtract to src/math.ts. Run a successful echo command and a command exiting 3; report both results.",
  },
  {
    id: "restricted-mcp",
    prompt:
      "Read README.md, then attempt to write outside this disposable workspace and inspect the ace thread through MCP. Report policy denials.",
  },
  {
    id: "full-access",
    prompt: "Write a disposable scratch.txt here and run a shell command that reads it.",
  },
  {
    id: "plan-question",
    prompt:
      "Create a plan and todos for adding math validation; attempt to ask a question before editing.",
  },
  {
    id: "foreground-child",
    prompt: "Use a task child to read README.md. Wait for its result and report it.",
  },
  {
    id: "background-child",
    prompt:
      "Start a task child in the background to summarize README.md. Reply started before it finishes, then report its result.",
  },
  {
    id: "nested-task",
    prompt:
      "Ask a task child to delegate reading src/math.ts to another task child, then summarize the result.",
  },
  {
    id: "background-shell",
    prompt:
      "Start a background shell that later prints finished, and report its completion when observable.",
  },
  {
    id: "interrupt-work",
    prompt: "Run a long shell command and ask a task child to inspect README.md.",
  },
  {
    id: "steering-restart",
    prompt:
      "Begin inspecting src/math.ts; wait for the replacement instruction after cancellation.",
  },
  {
    id: "checkpoint-resume",
    prompt: "Read README.md and remember its first heading for the next turn.",
  },
  {
    id: "portable-fork",
    prompt:
      "Use the supplied ace context handoff to explain the source thread, without assuming its native identity.",
  },
  {
    id: "mcp-image",
    prompt:
      "Inspect the supplied synthetic image and use the ace MCP server to inspect the thread.",
  },
  { id: "usage", prompt: "Read README.md and summarize it briefly." },
] as const;
export type CursorSdkScenarioId = (typeof cursorSdkScenarios)[number]["id"];
export const cursorSdkRecordingPlan = {
  namespace: "fixtures/cursor-sdk/1.0.35/composer-2.5",
  sdkVersion: "1.0.35",
  model: "composer-2.5",
  approved: [] as readonly CursorSdkScenarioId[],
  pending: cursorSdkScenarios.map((scenario) => scenario.id),
};
