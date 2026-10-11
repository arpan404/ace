import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { createAcpAdapter } from "./index.ts";

test("registry identity keeps unknown and passive native diagnostics drainable exactly once", () => {
  const translator = createAcpAdapter().createTranslator({
    threadId: ThreadId.parse("registry-diagnostics"),
    rootKey: "root",
    acpIdentity: {
      acpAgentId: "claude-bridge",
      installationId: "installed",
      instanceId: "account",
    },
  });
  let seq = 0;
  const feed = (data: unknown, dir: "recv" | "send" = "recv") =>
    translator.translate({ seq: ++seq, t: seq, dir, channel: "stdio", data }, seq);
  feed({ id: 1, method: "session/new", params: { cwd: "/workspace" } }, "send");
  const facts = feed({ id: 1, result: { sessionId: "native" } });
  expect(facts).toContainEqual(
    expect.objectContaining({
      type: "agent.seen",
      native: expect.objectContaining({ acpAgentId: "claude-bridge" }),
    }),
  );
  translator.takeDiagnostics?.();
  const unknown = { method: "vendor/future_notification", params: { opaque: "must survive" } };
  feed(unknown);
  expect(translator.takeDiagnostics?.()).toContainEqual(expect.objectContaining({ data: unknown }));
  expect(translator.takeDiagnostics?.()).toEqual([]);
  feed({
    method: "session/update",
    params: {
      sessionId: "native",
      update: { sessionUpdate: "tool_call", toolCallId: "read", kind: "read", status: "completed" },
    },
  });
  translator.takeDiagnostics?.();
  const refresh = {
    method: "session/update",
    params: {
      sessionId: "native",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "read",
        rawOutput: { content: "late" },
      },
    },
  };
  feed(refresh);
  expect(translator.takeDiagnostics?.()).toContainEqual(expect.objectContaining({ data: refresh }));
  expect(translator.takeDiagnostics?.()).toEqual([]);
});
