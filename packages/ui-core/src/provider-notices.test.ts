import { Item } from "@ace/protocol";
import { expect, test } from "vitest";
import { inputLine, repeatsEarlierEvent, systemInput, taskPrompt } from "./system-events.ts";

/* Rows as the daemon stored them before the adapters classified provider notifications. */
let ids = 0;
const stored = (role: "user" | "assistant", text: string, extra: Record<string, unknown> = {}) =>
  Item.parse({
    id: `m-${++ids}`,
    agentId: "root",
    createdAt: ids,
    complete: true,
    type: "message",
    role,
    synthetic: true,
    parts: [{ type: "text", text }],
    ...extra,
  });
const shellText = (command: string) =>
  `<shell id="sh_147d2cdec001M0xrJeYsu7l5wt" state="completed" command="${command}">\n 2 files changed\n\n</shell>`;
const openCodeShell = (command: string) =>
  stored("assistant", shellText(command), {
    nativeId: "msg_147d2cdee002TLt8p7m1pG1csD",
    raw: [
      {
        type: "projected.message",
        data: {
          type: "synthetic",
          metadata: { source: "shell", shellID: "sh_147d2cdec001M0xrJeYsu7l5wt", exit: 0 },
        },
      },
    ],
  });
const claudeNotification = (summary: string) =>
  stored(
    "user",
    `<task-notification>\n<task-id>b3m9m1xq0</task-id>\n<tool-use-id>toolu_016rxuJ1ZNE6um6CJqDM6LZJ</tool-use-id>\n<output-file>/private/tmp/claude-501/tasks/b3m9m1xq0.output</output-file>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>`,
  );
const line = (item: Item) => {
  const input = systemInput(item);
  return input && inputLine(input);
};

test("a stored OpenCode shell completion reads as a finished background task", () => {
  expect(systemInput(openCodeShell("git diff --stat"))?.kind).toBe("background_completion");
  expect(line(openCodeShell("git diff --stat"))?.text).toMatch(/^Background task finished/);
});

test("a stored OpenCode shell completion without its raw payload is still recognised", () => {
  expect(line(stored("assistant", shellText("bun install")))?.text).toMatch(
    /^Background task finished/,
  );
});

test("a stored Claude task notification reads as a finished background task", () => {
  const item = claudeNotification(
    'Background command "bun run check:deps" completed (exit code 0)',
  );
  expect(systemInput(item)?.kind).toBe("background_completion");
  expect(line(item)?.text).toMatch(/^Background task finished/);
});

test("a Claude notification about a finished agent is a subagent result", () => {
  expect(systemInput(claudeNotification('Agent "Audit" completed'))?.kind).toBe("subagent_result");
});

test("a stored OpenCode child result stays a subagent result, shown as its card", () => {
  const item = stored(
    "assistant",
    '<subagent sessionID="ses_eb7fed12dffeNStaf7L2JRNrPd" state="completed" description="Audit">\nAll verification complete.\n\n</subagent>',
    { raw: [{ type: "projected.message", data: { metadata: { source: "subagent" } } }] },
  );
  const input = systemInput(item);
  expect(input?.kind).toBe("subagent_result");
  // Results are a card, never a quiet line.
  expect(input && inputLine(input)).toBeUndefined();
});

test("another agent's message shows its words without Claude's envelope", () => {
  const item = stored(
    "user",
    '<agent-message from="a922a04248ae74488">\nFYI: my Swift now compiles.\n</agent-message>',
  );
  const input = systemInput(item);
  expect(input?.kind).toBe("parent_agent");
  expect(input && taskPrompt(input)?.task).toBe("FYI: my Swift now compiles.");
});

test("the person's own text shaped like a notification stays theirs", () => {
  const typed = Item.parse({
    ...stored("user", shellText("ls")),
    synthetic: false,
  });
  expect(systemInput(typed)).toBeUndefined();
});

test("assistant prose that merely starts like a notification is still prose", () => {
  const prose = Item.parse({ ...stored("assistant", shellText("ls")), synthetic: false });
  expect(systemInput(prose)).toBeUndefined();
});

test("consecutive completions of different commands each keep their row", () => {
  const items = [openCodeShell("bun install"), openCodeShell("git diff --stat")];
  const order = items.map((item) => item.id);
  const byId = (id: string) => items.find((item) => item.id === id);
  expect(repeatsEarlierEvent(order, 1, byId, "background_completion")).toBe(false);
});

/* Claude's own notes, which older daemons stamped with the woken run's trigger. */
const stampedNote = (kind: "background_completion" | "subagent_result", text: string) =>
  stored("user", text, { origin: { kind } });

test("Claude's image note stamped with a woken run's trigger is neither a finished task nor a result", () => {
  const note =
    "[Image: original 1206x2622, displayed at 920x2000. Multiply coordinates by 1.31 to map to original image.]";
  expect(systemInput(stampedNote("background_completion", note))).toBeUndefined();
  expect(systemInput(stampedNote("subagent_result", note))).toBeUndefined();
  expect(
    systemInput(stampedNote("subagent_result", "[Request interrupted by user for tool use]")),
  ).toBeUndefined();
});

test("a provider notice the adapter stamped keeps its kind", () => {
  const item = Item.parse({
    ...claudeNotification('Background command "ls" completed (exit code 0)'),
    origin: { kind: "background_completion" },
  });
  expect(systemInput(item)?.kind).toBe("background_completion");
});

test("ace's own delegation result keeps its kind whatever its text", () => {
  const item = stored("user", "Results are in.", {
    origin: { kind: "subagent_result", commandId: "result", threadIds: ["child"] },
  });
  expect(systemInput(item)?.kind).toBe("subagent_result");
});
