import { expect, it } from "vitest";
import { ThreadId } from "@ace/protocol";
import { FakeDaemon, ScenarioPlayer, aceToolRows } from "./index.ts";

it("all provider-shaped demo calls expose typed images and errors with notices linked to the canonical step", () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  for (const scenario of aceToolRows()) {
    new ScenarioPlayer(daemon, scenario).runUntilBlocked();
    const view = daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(scenario.thread.id) });
    if (view?.kind !== "thread") throw new Error("No thread");
    const items = Object.values(view.items);
    const call = items.find(
      (item) =>
        item.type === "tool_call" &&
        item.call.detail.kind === "mcp" &&
        item.call.detail.tool === "screen_screenshot",
    );
    if (call?.type !== "tool_call") throw new Error("No screenshot");
    expect(call.call.result).toMatchObject({
      isError: false,
      content: [
        expect.objectContaining({
          type: "image",
          attachment: expect.objectContaining({ mimeType: "image/png", width: 120, height: 80 }),
        }),
        expect.anything(),
      ],
      target: { displayName: "TextEdit" },
    });
    expect(
      items.find((item) => item.type === "notice" && item.toolCallId === call.id),
    ).toMatchObject({
      code: "screen.step",
      raw: [{ data: { toolCallId: call.id, bundleId: "com.apple.TextEdit" } }],
    });
    const failure = items.find(
      (item) => item.type === "tool_call" && item.call.status === "failed",
    );
    expect(JSON.stringify(failure)).toContain("Text destination changed");
    expect(items.filter((item) => item.type === "tool_call")).toHaveLength(5);
  }
});
