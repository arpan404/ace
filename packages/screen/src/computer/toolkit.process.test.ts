import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { computerWorld, type WorldOptions } from "./testing/world.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function world(options: WorldOptions = {}) {
  const made = await computerWorld(options);
  cleanups.push(made.close);
  return made;
}

async function marker(name: string) {
  const dir = await mkdtemp(join(tmpdir(), "ace-computer-marker-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return join(dir, name);
}

it("an agent reads the outline once, then only the change its actions caused", async () => {
  const { call } = await world();
  const first = await call("screen_state", { app: "Calculator" });
  expect(first.text).toContain("1 standard window Calculator\n\t6 text 0\n\t23 button 7");
  expect(first.text).toContain("Menu bar: Calculator, Edit");

  const acted = await call("screen_act", {
    app: "Calculator",
    actions: [{ type: "type", text: "12*34=" }],
  });
  expect(acted.result.isError).toBeFalsy();
  expect(acted.text).toContain("1. typed 6 characters");
  expect(acted.text).toContain("~\t6 text 408");
  expect(acted.text).not.toContain("23 button 7");

  expect((await call("screen_state", { app: "Calculator" })).text).toContain(
    "No change since your last look.",
  );
});

it("an app name resolves once per agent, so later looks and actions go straight to the app", async () => {
  const { call, ops } = await world();
  await call("screen_state", { app: "Calculator" });
  await call("screen_act", { app: "calculator", actions: [{ type: "key", key: "Escape" }] });
  await call("screen_state", { app: "Calculator" });
  expect((await ops()).filter((op) => op.startsWith("resolve"))).toEqual(["resolve Calculator"]);
});

it("a terminal is refused before the helper opens or touches it", async () => {
  const { call, ops } = await world();
  const refused = await call("screen_act", {
    app: "Terminal",
    actions: [{ type: "type", text: "rm -rf ~" }],
  });
  expect(refused.result.isError).toBe(true);
  expect(refused.text).toContain("does not operate this app");
  expect(await ops()).toEqual(["resolve Terminal"]);
});

it("ace itself and terminals whose bundle id differs in case are refused", async () => {
  const { call } = await world();
  expect((await call("screen_state", { app: "ace" })).text).toContain("it is ace itself");
  expect((await call("screen_state", { app: "Ghostty" })).text).toContain(
    "does not operate this app",
  );
});

it("apps the person listed are refused by name or bundle id, in any case", async () => {
  let listed: readonly string[] = ["calculator", "COM.APPLE.TEXTEDIT"];
  const { call, ops } = await world({ toolkit: { blockedApps: async () => listed } });
  for (const app of ["Calculator", "TextEdit"]) {
    const refused = await call("screen_act", { app, actions: [{ type: "key", key: "Escape" }] });
    expect(refused.result.isError).toBe(true);
    expect(refused.text).toContain("Apps agents can't use");
  }
  expect((await ops()).filter((op) => !op.startsWith("resolve"))).toEqual([]);
  // The list is read on every call, so taking an app off it frees it at once.
  listed = [];
  expect((await call("screen_state", { app: "Calculator" })).text).toContain("6 text 0");
});

it("the helper's own explanation of a failed step reaches the model, with what already ran", async () => {
  const { call } = await world();
  await call("screen_state", { app: "Calculator" });
  const partial = await call("screen_act", {
    app: "Calculator",
    actions: [
      { type: "key", key: "Escape" },
      { type: "menu", path: ["Fiel", "New"] },
      { type: "type", text: "x" },
    ],
  });
  expect(partial.result.isError).toBe(true);
  expect(partial.text).toContain("1. did key");
  expect(partial.text).toContain(
    'Action 2 (menu) failed: No "Fiel" in the menu bar. Items: Calculator, Edit. The actions after it did not run.',
  );
});

it("a step whose condition is not met is skipped, not failed, and does not count as input", async () => {
  const { call } = await world();
  await call("screen_state", { app: "Calculator" });
  const acted = await call("screen_act", {
    app: "Calculator",
    actions: [
      { type: "type", text: "1", when: { text: "Save changes?" } },
      { type: "click", id: 23, when: { text: "7" } },
    ],
  });
  expect(acted.result.isError).toBeFalsy();
  expect(acted.text).toContain("1. skipped type: condition not met\n2. did click");
  expect(acted.text).not.toContain("That had no visible effect");
});

it("an app that stopped responding is named, and the timing the helper reports stays out", async () => {
  const { call } = await world();
  const { text } = await call("screen_state", { app: "Frozen" });
  expect(text).toContain("Frozen is not responding; the outline may be partial.");
  expect(text).toContain("6 text 0");
  expect(text).not.toContain("1200");
});

it("a picture-only look returns the screenshot without reading the outline", async () => {
  const { call } = await world();
  const { result, text } = await call("screen_state", { app: "Calculator", outline: false });
  expect(result.content.some((part) => part.type === "image")).toBe(true);
  expect(text).toContain('Window: "Calculator"');
  expect(text).toContain("Screenshot: 674×408 px.");
  expect(text).not.toContain("23 button 7");
});

it("an unknown app gets the helper's suggestion, not a generic failure", async () => {
  const { call } = await world();
  const missing = await call("screen_state", { app: "Photoshop" });
  expect(missing.result.isError).toBe(true);
  expect(missing.text).toBe('No installed app matches "Photoshop".');
});

it("a step missing what it acts on is refused with a reason the model can fix", async () => {
  const { call, ops } = await world();
  const cases: [Record<string, unknown>, string][] = [
    [{ type: "click" }, "click needs id or x,y"],
    [{ type: "click", x: 4 }, "click needs both x and y"],
    [{ type: "scroll", direction: "down", pages: 1, pixels: 40 }, "pages or pixels, not both"],
    [{ type: "wait_for", timeout_ms: 500 }, "wait_for needs text or id"],
    [{ type: "move", id: 3, x: 1, y: 2 }, "move takes id or x,y, not both"],
    [{ type: "window", op: "resize", width: 300 }, "window resize needs width and height"],
    [{ type: "window", op: "move", x: 10 }, "window move needs x and y"],
  ];
  for (const [action, reason] of cases) {
    const refused = await call("screen_act", { app: "Calculator", actions: [action] });
    expect(refused.result.isError, reason).toBe(true);
    expect(refused.text, reason).toContain(reason);
  }
  expect(await ops()).toEqual([]);
});

it("a helper that crashes costs one call; the next call starts a fresh helper", async () => {
  const { call, children } = await world({ env: { FAKE_CRASH_ONCE: await marker("crashed") } });
  const crashed = await call("screen_state", { app: "Calculator" });
  expect(crashed.result.isError).toBe(true);
  expect(crashed.text).toContain("helper stopped");
  const started = children.length;
  expect((await call("screen_state", { app: "Calculator" })).text).toContain("6 text 0");
  expect(children.length).toBe(started + 1);
});

it("a screenshot arrives as an image with its coordinate space explained", async () => {
  const { call } = await world();
  const { result, text } = await call("screen_state", { app: "Calculator", screenshot: true });
  expect(
    result.content.some((part) => part.type === "image" && part.mimeType === "image/jpeg"),
  ).toBe(true);
  expect(text).toContain("Screenshot: 674×408 px. Click coordinates are pixels in this image.");
});

it("a shortcut that changed nothing tells the agent to use a control or bring the app forward", async () => {
  const { call } = await world();
  await call("screen_state", { app: "Calculator" });
  const ignored = await call("screen_act", {
    app: "Calculator",
    actions: [{ type: "key", key: "cmd+s" }],
  });
  expect(ignored.text).toContain("No change since your last look.");
  expect(ignored.text).toContain("That had no visible effect.");
});

it("a thread is reported as using an app for exactly as long as each call runs", async () => {
  const events: string[] = [];
  const { call } = await world({
    toolkit: {
      using: (thread, app) => {
        events.push(`+${thread} ${app}`);
        return () => events.push(`-${thread} ${app}`);
      },
    },
  });
  await call("screen_state", { app: "Calculator" });
  await call("screen_act", { app: "Terminal", actions: [{ type: "key", key: "Escape" }] });
  expect(events).toEqual(["+thread Calculator", "-thread Calculator"]);
});
