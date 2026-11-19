import { expect, it } from "vitest";
import { AgentId, ThreadId } from "@ace/protocol";
import { computerToolkit, ComputerError } from "@ace/screen";
import { TargetScreen } from "./target-screen.ts";
import { computerUse } from "./screen-test-support.ts";

it("a remote agent cannot borrow another agent's protected computer interval", async () => {
  const mac = await computerUse();
  const screen = new TargetScreen({
    computer: () => mac.computer,
    enabled: () => true,
    toolkit: (client) =>
      computerToolkit(client, {
        // The Locked Use boundary admits one agent; a sibling must receive its own refusal.
        lockedUse: async (call, send) => {
          if (call.agentId !== "remote:allowed")
            throw new ComputerError(
              "locked_use_interval_active",
              "Another agent owns the protected interval.",
            );
          return send(call.signal);
        },
      }),
  });
  const session = {
    threadId: ThreadId.parse("guest"),
    agentId: AgentId.parse("root"),
    deviceId: "linux",
    agent: AgentId.parse("remote:allowed"),
    owner: "guest/remote:allowed",
  };
  const look = (agent: string) =>
    screen.call(
      { ...session, agent: AgentId.parse(agent), owner: `guest/${agent}` },
      "screen_state",
      { app: "Calculator" },
      new AbortController().signal,
    );
  const allowed = await look("remote:allowed");
  expect(allowed.isError).not.toBe(true);
  expect(allowed.content).toContainEqual(
    expect.objectContaining({ type: "text", text: expect.stringContaining("Calculator") }),
  );
  expect(await look("remote:sibling")).toMatchObject({
    isError: true,
    content: [{ type: "text", text: "Another agent owns the protected interval." }],
  });
});
