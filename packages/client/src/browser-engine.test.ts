import { describe, expect, it } from "vitest";
import type { BrowserState } from "@ace/protocol";
import type { ClientApi } from "./api.ts";
import { moveBrowserEngine } from "./browser-engine.ts";

/** A daemon that answers an engine move with `reply`, keeping what it was asked. */
function daemon(reply: { ok: boolean; result?: unknown; error?: string }) {
  const asked: Record<string, unknown>[] = [];
  const request = async (input: Record<string, unknown>) => {
    asked.push(input);
    return input.type === "browser.engine.move"
      ? { type: "browser.result", requestId: "r", ...reply }
      : { type: "browser.result", requestId: "r", ok: false, error: "unknown" };
  };
  return { client: { request } as unknown as Pick<ClientApi, "request">, asked };
}

const input = { threadId: "thread-1", workspaceId: "workspace-1" };
const moved = {
  threadId: "thread-1",
  url: "https://two.example/",
  closed: false,
  backend: "headless",
  activeTabId: "t2",
  tabs: [
    { tabId: "t1", url: "https://one.example/", title: "" },
    { tabId: "t2", url: "https://two.example/", title: "" },
  ],
};

describe("switching a thread's browser engine", () => {
  it("asks the daemon for the move and hears the browser on its new engine", async () => {
    const machine = daemon({ ok: true, result: { state: moved, failed: [] } });
    const heard: BrowserState[] = [];
    const result = await moveBrowserEngine(machine.client, { ...input, engine: "headless" }, (s) =>
      heard.push(s),
    );
    expect(machine.asked).toEqual([{ type: "browser.engine.move", ...input, engine: "headless" }]);
    expect(result.activeTabId).toBe("t2");
    expect(heard.map((state) => state.backend)).toEqual(["headless"]);
  });

  it("keeps the choice for a thread with no browser without reporting one", async () => {
    const machine = daemon({ ok: true, result: { failed: [] } });
    const heard: BrowserState[] = [];
    const result = await moveBrowserEngine(machine.client, { ...input, engine: "embedded" }, (s) =>
      heard.push(s),
    );
    expect(result.activeTabId).toBeUndefined();
    expect(heard).toEqual([]);
  });

  it("passes on the daemon's reason when the new engine won't open", async () => {
    const machine = daemon({
      ok: false,
      error: "Couldn't open the browser there, so it stayed where it was. No window",
    });
    await expect(
      moveBrowserEngine(machine.client, { ...input, engine: "embedded" }),
    ).rejects.toThrow(/stayed where it was\. No window/);
  });

  it("names the pages that didn't reload once the rest have moved", async () => {
    const machine = daemon({
      ok: true,
      result: {
        state: moved,
        failed: [{ url: "https://down.example/", reason: "net::ERR_CONNECTION_REFUSED" }],
      },
    });
    await expect(
      moveBrowserEngine(machine.client, { ...input, engine: "headless" }),
    ).rejects.toThrow(/this tab didn't reload: https:\/\/down\.example\//);
  });
});
