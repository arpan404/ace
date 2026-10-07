import { expect, it } from "vitest";
import { backendFixture } from "./backend-test-support.ts";
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
it("an interrupted drag leaves subsequent pointer ownership to a new controller", async () => {
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
      f.service.takeover("thread", "person");
    }
    if (method === "Input.dispatchMouseEvent" && params?.["type"] === "mouseReleased")
      pressed = false;
    return send(method, params);
  };
  await expect(
    f.service.execute("thread", { action: "drag", ref, toRef: ref }),
  ).rejects.toMatchObject({ code: "human_controlled" });
  expect(pressed).toBe(true);
  await f.service.input(
    "thread",
    { kind: "mouse", event: "mouseReleased", x: 0, y: 0, button: "left" },
    "person",
  );
  expect(pressed).toBe(false);
});
