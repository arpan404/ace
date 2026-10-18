import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { cursorFixture, executablePath } from "./cursor-test-support.ts";
import { ref, Snapshot } from "./test-support.ts";

const test = it.skipIf(!executablePath);

describe.skipIf(!executablePath)("the agent cursor drawn in the page", () => {
  test("the person sees the agent's cursor land where it clicks, and the click reaches the page", async () => {
    const f = await cursorFixture();
    const go = await f.box("#go");
    const at = { x: go.x + go.width / 2, y: go.y + go.height / 2 };
    await f.agentRun({ action: "click", ref: ref(await f.agentRun({ action: "snapshot" }), "Go") });
    expect(await f.evaluate("pageClicks")).toBe(1);
    await f.seen(at.x, at.y, true);
  }, 60_000);

  test("the agent's own screenshot and snapshot leave the cursor out", async () => {
    const f = await cursorFixture();
    const go = await f.box("#go");
    const at = { x: go.x + go.width / 2, y: go.y + go.height / 2 };
    await f.agentRun({ action: "click", ref: ref(await f.agentRun({ action: "snapshot" }), "Go") });
    await f.seen(at.x, at.y, true);
    const shot = await f.service.screenshot(
      "thread",
      undefined,
      undefined,
      {},
      {
        kind: "agent",
        agentId: "helper",
      },
    );
    expect(await f.accentNear(await f.bytesImage(shot), at.x, at.y)).toBe(false);
    const snapshot = Snapshot.parse(await f.agentRun({ action: "snapshot" }));
    expect(snapshot.nodes.some((node) => node.name.includes("Helper"))).toBe(false);
    // Once the capture is done the person sees the cursor again.
    await f.seen(at.x, at.y, true);
  }, 60_000);

  test("the cursor comes back on the next page after the agent's click navigates", async () => {
    const f = await cursorFixture();
    const link = await f.box("#next");
    const at = { x: link.x + link.width / 2, y: link.y + link.height / 2 };
    await f.agentRun({
      action: "click",
      ref: ref(await f.agentRun({ action: "snapshot" }), "Next page"),
    });
    // The layer leaves the page itself.
    await vi.waitFor(async () => expect(await f.evaluate("location.pathname")).toBe("/next"), {
      timeout: 8_000,
    });
    await f.seen(at.x, at.y, true);
  }, 60_000);

  test("a tab the person keeps private shows no agent cursor", async () => {
    const f = await cursorFixture();
    const go = await f.box("#go");
    const at = { x: go.x + go.width / 2, y: go.y + go.height / 2 };
    await f.agentRun({ action: "click", ref: ref(await f.agentRun({ action: "snapshot" }), "Go") });
    await f.seen(at.x, at.y, true);
    const tabId = z.string().parse(f.service.state("thread").activeTabId);
    f.service.setPrivate("thread", tabId, true);
    // The layer leaves the page itself.
    await vi.waitFor(async () =>
      expect(
        await f.personRun({
          action: "evaluate",
          expression: "document.querySelector('ace-agent-cursor') === null",
        }),
      ).toBe(true),
    );
  }, 60_000);

  test("the cursor steps aside while the person uses the page, then returns", async () => {
    const f = await cursorFixture({
      collaboration: { quietMs: 600, maxWaitMs: 10_000, inUseMs: 20_000, followAfterMs: 30_000 },
    });
    const go = await f.box("#go");
    const at = { x: go.x + go.width / 2, y: go.y + go.height / 2 };
    await f.agentRun({ action: "click", ref: ref(await f.agentRun({ action: "snapshot" }), "Go") });
    await f.seen(at.x, at.y, true);
    await f.service.input(
      "thread",
      { kind: "mouse", event: "mouseMoved", x: 20, y: 20, button: "none" },
      "person",
    );
    await f.seen(at.x, at.y, false);
    await f.seen(at.x, at.y, true);
  }, 60_000);
});
