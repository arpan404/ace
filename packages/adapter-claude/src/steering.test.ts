import { expect, test } from "vitest";
import { harness } from "./translator.test-helper.ts";

/** The person's message delivered into the running turn, as the session writes it. */
const steer = (h: ReturnType<typeof harness>, text: string) =>
  h.send(
    {
      type: "user",
      uuid: `steer-${text}`,
      session_id: "s",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "text", text }] },
      priority: "now",
    },
    "sdk",
    "send",
  );
/** What Claude reports when it cuts the running request short (CLI 2.1.302 frames). */
const aborted = { is_error: true, subtype: "error_during_execution" };
const runs = (h: ReturnType<typeof harness>) => Object.values(h.state.runs).map((run) => run.state);

test("a steered turn keeps working through the steer and ends once, completed", () => {
  const h = harness();
  h.init();
  h.tool("read", "Read", { file_path: "/repo/a.ts" });
  steer(h, "check mobile too");
  // Claude aborts its in-flight request to take the steer at once.
  h.result({ ...aborted, terminal_reason: "aborted_streaming" });
  expect(h.state.status.state).toBe("working");
  expect(runs(h)).toEqual(["active"]);
  // It runs the steer straight after, on the same conversation.
  h.init();
  h.send({
    type: "assistant",
    message: { id: "m:answer", content: [{ type: "text", text: "Mobile checked too." }] },
    parent_tool_use_id: null,
  });
  h.result();
  expect(runs(h)).toEqual(["completed"]);
  expect(h.events.filter((event) => event.type === "run.ended")).toHaveLength(1);
  expect(h.state.status.state).toBe("done");
});

test("a steer that aborts running tools still carries the turn on", () => {
  const h = harness();
  h.init();
  h.tool("bash", "Bash", { command: "bun run build" });
  steer(h, "skip the docs");
  h.result({ ...aborted, terminal_reason: "aborted_tools" });
  expect(h.state.status.state).toBe("working");
  expect(runs(h)).toEqual(["active"]);
});

test("stopping a steered turn reads as stopped, whichever was sent first", () => {
  const h = harness();
  h.init();
  steer(h, "also update the tests");
  h.send(
    { type: "control_request", request_id: "stop-1", request: { subtype: "interrupt" } },
    "wire",
    "send",
  );
  h.result({ ...aborted, terminal_reason: "aborted_streaming" });
  expect(runs(h)).toEqual(["interrupted"]);
  expect(h.state.agents["root"]?.agent.status.state).toBe("interrupted");
});

test("a turn aborted after its steer was already taken reads as stopped", () => {
  const h = harness();
  h.init();
  steer(h, "rename it");
  h.result({ ...aborted, terminal_reason: "aborted_streaming" });
  h.init();
  // A cancelled approval is Claude's interrupt too.
  h.send(
    {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "ask-1",
        response: { behavior: "deny", message: "Plan rejected.", interrupt: true },
      },
    },
    "wire",
    "send",
  );
  h.result({ ...aborted, terminal_reason: "aborted_tools" });
  expect(runs(h)).toEqual(["interrupted"]);
});
