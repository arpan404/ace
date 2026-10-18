import { expect, it } from "vitest";
import { backendFixture } from "./backend-test-support.ts";
import { keepAgentsOut } from "./collaboration-test-support.ts";
import { z } from "zod";

it("an aborted drag releases the pointer it pressed in the same document and lease", async () => {
  const f = await backendFixture({ backendPreference: () => "headless" });
  await f.open();
  const page = f.headless.pages[0];
  if (!page) throw new Error("Missing page");
  const snapshot = z
    .object({ nodes: z.array(z.object({ ref: z.string() })) })
    .parse(await f.service.execute("thread", { action: "snapshot" }));
  const ref = snapshot.nodes[0]?.ref;
  if (!ref) throw new Error("Missing ref");
  const abort = new AbortController();
  let pressed = false;
  const send = page.cdp.send;
  page.cdp.send = async (method, params) => {
    if (method === "Input.dispatchMouseEvent" && params?.["type"] === "mousePressed") {
      pressed = true;
      abort.abort(new Error("cancelled drag"));
    }
    if (method === "Input.dispatchMouseEvent" && params?.["type"] === "mouseReleased")
      pressed = false;
    return send(method, params);
  };
  await expect(
    f.service.execute(
      "thread",
      { action: "drag", ref, toRef: ref },
      { kind: "agent" },
      abort.signal,
    ),
  ).rejects.toThrow("cancelled drag");
  expect(pressed).toBe(false);
});
it("a drag interrupted by the person keeping agents out leaves the pointer to the person", async () => {
  const f = await backendFixture({ backendPreference: () => "headless" });
  await f.open();
  const page = f.headless.pages[0];
  if (!page) throw new Error("Missing page");
  const snapshot = z
    .object({ nodes: z.array(z.object({ ref: z.string() })) })
    .parse(await f.service.execute("thread", { action: "snapshot" }));
  const ref = snapshot.nodes[0]?.ref;
  if (!ref) throw new Error("Missing ref");
  let pressed = false;
  const send = page.cdp.send;
  page.cdp.send = async (method, params) => {
    if (method === "Input.dispatchMouseEvent" && params?.["type"] === "mousePressed") {
      pressed = true;
      keepAgentsOut(f.service);
    }
    if (method === "Input.dispatchMouseEvent" && params?.["type"] === "mouseReleased")
      pressed = false;
    return send(method, params);
  };
  await expect(
    f.service.execute("thread", { action: "drag", ref, toRef: ref }),
  ).rejects.toMatchObject({ code: "human_private" });
  expect(pressed).toBe(true);
  await f.service.input(
    "thread",
    { kind: "mouse", event: "mouseReleased", x: 0, y: 0, button: "left" },
    "person",
  );
  expect(pressed).toBe(false);
});
it("an agent's drag lets go when the person comes back in the middle of it", async () => {
  const f = await backendFixture({
    backendPreference: () => "headless",
    collaboration: {
      quietMs: 1_500,
      maxWaitMs: 10_000,
      inUseMs: 1_000,
      followAfterMs: 1_000,
      presentMs: 1_000,
    },
  });
  await f.open();
  const page = f.headless.pages[0];
  if (!page) throw new Error("Missing page");
  const snapshot = z
    .object({ nodes: z.array(z.object({ ref: z.string() })) })
    .parse(await f.service.execute("thread", { action: "snapshot" }, { kind: "agent" }));
  const ref = snapshot.nodes[0]?.ref;
  if (!ref) throw new Error("Missing ref");
  const mouse: string[] = [];
  const send = page.cdp.send;
  page.cdp.send = async (method, params) => {
    // The agent's own pointer events; the person's arrive at (1, 1).
    if (method === "Input.dispatchMouseEvent" && params?.["x"] !== 1) {
      mouse.push(String(params?.["type"]));
      // The person moves their own mouse just as the agent presses its button.
      if (params?.["type"] === "mousePressed")
        void f.service.input(
          "thread",
          { kind: "mouse", event: "mouseMoved", x: 1, y: 1, button: "none" },
          "person",
        );
    }
    return send(method, params);
  };
  await expect(
    f.service.execute("thread", { action: "drag", ref, toRef: ref }, { kind: "agent" }),
  ).rejects.toMatchObject({ code: "human_active" });
  // The agent pressed, then let go where it was without moving on across the person.
  expect(mouse).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
});
