import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { computerWorld, type WorldOptions } from "./testing/world.ts";
import { ScreenCowork } from "../cowork.ts";
import { helperGate } from "../testing/gate.ts";
import { deferred } from "../testing/support.ts";

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

it("steps an if does not hold for are skipped, not failed, and do not count as input", async () => {
  const { call } = await world();
  await call("screen_state", { app: "Calculator" });
  const acted = await call("screen_act", {
    app: "Calculator",
    actions: [
      { type: "if", text: "Save changes?" },
      { type: "type", text: "1" },
      { type: "if", text: "7" },
      { type: "click", id: 23 },
    ],
  });
  expect(acted.result.isError).toBeFalsy();
  // Lines keep the model's own step numbers; the if steps themselves report nothing.
  expect(acted.text).toContain("2. skipped type: condition not met\n4. did click");
  expect(acted.text).not.toContain("That had no visible effect");
});

it("an if guards as many steps as it says, and a malformed if is refused before acting", async () => {
  const { call } = await world();
  await call("screen_state", { app: "Calculator" });
  const guarded = await call("screen_act", {
    app: "Calculator",
    actions: [
      { type: "if", text: "Save changes?", steps: 2 },
      { type: "type", text: "1" },
      { type: "type", text: "2" },
      { type: "click", id: 23 },
    ],
  });
  expect(guarded.text).toContain(
    "2. skipped type: condition not met\n3. skipped type: condition not met\n4. did click",
  );
  const overrun = await call("screen_act", {
    app: "Calculator",
    actions: [
      { type: "click", id: 23 },
      { type: "if", text: "7", steps: 2 },
      { type: "type", text: "1" },
    ],
  });
  expect(overrun.result.isError).toBe(true);
  expect(overrun.text).toContain("guards 2 steps, but fewer follow it");
  const nested = await call("screen_act", {
    app: "Calculator",
    actions: [
      { type: "if", text: "7", steps: 2 },
      { type: "if", text: "8" },
      { type: "type", text: "1" },
    ],
  });
  expect(nested.text).toContain("inside the steps of an earlier if");
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

const pictures = (result: { content: { type: string; data?: string }[] }) =>
  result.content.flatMap((part) =>
    part.type === "image" && part.data ? [Buffer.from(part.data, "base64").toString()] : [],
  );

it("a look at the displays pictures each one, leaving out apps computer use refuses", async () => {
  const { call, ops } = await world();
  const { result, text } = await call("screen_display", {});
  expect(result.isError).toBeFalsy();
  expect(text).toContain(
    "1. Built-in Retina Display, 1512×982, main\n2. PHL 241V8LB, 1080×1920, rotated 270°",
  );
  expect(text).toContain("Left out of the pictures, as apps computer use refuses: Ghostty, ace.");
  expect(pictures(result)).toEqual(["display 1", "display 2"]);
  // The helper pictures only the windows of apps that are allowed.
  expect(await ops()).toContain("included com.apple.calculator,com.apple.TextEdit");
});

it("apps the person listed stay out of display pictures too", async () => {
  const { call, ops } = await world({ toolkit: { blockedApps: async () => ["textedit"] } });
  const { text } = await call("screen_display", { display: 2 });
  expect(text).toContain("refuses: Ghostty, ace, TextEdit.");
  expect(await ops()).toContain("included com.apple.calculator");
});

it("one display can be pictured alone, and a missing one names those there are", async () => {
  const { call, ops } = await world();
  const one = await call("screen_display", { display: 2 });
  expect(pictures(one.result)).toEqual(["display 2"]);
  expect(one.text).not.toContain("Built-in");

  const missing = await call("screen_display", { display: 3 });
  expect(missing.result.isError).toBe(true);
  expect(missing.text).toContain("There is no display 3. Displays:\n1. Built-in Retina Display");
  expect((await ops()).filter((op) => op.startsWith("capture_displays"))).toHaveLength(1);
});

it("a helper from before display pictures says ace needs updating", async () => {
  const { call } = await world({ env: { FAKE_NO_DISPLAYS: "1" } });
  const { result, text } = await call("screen_display", {});
  expect(result.isError).toBe(true);
  expect(text).toContain("too old to picture displays");
});

it("Linux agents are not offered display pictures", async () => {
  const { call, ops } = await world({ toolkit: { platform: "linux" } });
  expect((await call("screen_display", {})).result.isError).toBe(true);
  expect(await ops()).toEqual([]);
});

/** A cowork clock that moves only when the test says so; `sleeping` resolves once a wait began. */
function coworkClock() {
  let now = 1_000_000;
  let timers: { at: number; run: () => void }[] = [];
  const clock = {
    now: () => now,
    set(ms: number, run: () => void) {
      const timer = { at: now + Math.max(0, ms), run };
      timers.push(timer);
      return () => {
        timers = timers.filter((each) => each !== timer);
      };
    },
  };
  const sleeping = async (count = 1) => {
    for (let tries = 0; timers.length < count; tries++) {
      if (tries > 2_000) throw new Error("No wait began");
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((timer) => timer.at <= end).toSorted((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((timer) => timer !== due);
      now = due.at;
      due.run();
    }
    now = end;
  };
  return { clock, sleeping, advance };
}

/** Lets the helper's replies and the waiters' next looks run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const acts = async (ops: () => Promise<string[]>) =>
  (await ops()).filter((op) => op.startsWith("act"));

it("in cowork an agent's act waits while the person uses the app, runs once they pause, and says so", async () => {
  const time = coworkClock();
  const cowork = new ScreenCowork({ clock: time.clock });
  const { call, ops } = await world({ toolkit: { cowork } });
  await call("screen_state", { app: "Calculator" });
  // The person types in Calculator through the live view; their lease runs 3 s.
  cowork.personInput(["com.apple.calculator"]);
  const acting = call("screen_act", {
    app: "Calculator",
    actions: [{ type: "key", key: "Escape" }],
  });
  // Another app stays free: an act there runs at once.
  const elsewhere = await call("screen_act", {
    app: "TextEdit",
    actions: [{ type: "key", key: "Escape" }],
  });
  expect(elsewhere.text).not.toContain("Waited");
  await time.sleeping();
  expect(await acts(ops)).toHaveLength(1);
  time.advance(2_000);
  cowork.personInput(["com.apple.calculator"]);
  await time.sleeping();
  time.advance(3_000);
  const acted = await acting;
  expect(acted.result.isError).toBeFalsy();
  expect(acted.text).toContain("Waited 5 s while the person used Calculator.");
  expect(await acts(ops)).toHaveLength(2);
});

it("in cowork a look never waits for the person", async () => {
  const time = coworkClock();
  const cowork = new ScreenCowork({ clock: time.clock });
  const { call } = await world({ toolkit: { cowork } });
  cowork.personInput(["com.apple.calculator"]);
  const looked = await call("screen_state", { app: "Calculator" });
  expect(looked.text).toContain("button 7");
});

it("after a minute of the person's use the act gives up with person_busy and nothing ran", async () => {
  const time = coworkClock();
  const cowork = new ScreenCowork({ clock: time.clock });
  const { call, ops } = await world({ toolkit: { cowork } });
  await call("screen_state", { app: "Calculator" });
  cowork.personInput(["com.apple.calculator"]);
  const acting = call("screen_act", { app: "Calculator", actions: [{ type: "type", text: "1" }] });
  await time.sleeping();
  for (let second = 0; second < 62; second++) {
    time.advance(1_000);
    cowork.personInput(["com.apple.calculator"]);
    await tick();
  }
  const refused = await acting;
  expect(refused.result.isError).toBe(true);
  expect(JSON.parse(refused.text)).toMatchObject({ code: "person_busy" });
  expect(await acts(ops)).toEqual([]);
});

it("the person typing on the machine while the app is frontmost holds the agent back", async () => {
  const time = coworkClock();
  let typingUntil = time.clock.now() + 4_000;
  const cowork = new ScreenCowork({
    clock: time.clock,
    // The machine's idle source: the person keeps typing into frontmost Calculator.
    physical: {
      lastInputAt: async () => Math.min(time.clock.now(), typingUntil),
      frontmost: async () => "com.apple.calculator",
    },
  });
  const { call, ops } = await world({ toolkit: { cowork } });
  await call("screen_state", { app: "Calculator" });
  // TextEdit is in the background: typing into Calculator doesn't hold it.
  const background = await call("screen_act", {
    app: "TextEdit",
    actions: [{ type: "key", key: "Escape" }],
  });
  expect(background.text).not.toContain("Waited");
  const acting = call("screen_act", {
    app: "Calculator",
    actions: [{ type: "key", key: "Escape" }],
  });
  await time.sleeping();
  time.advance(3_000);
  await tick();
  typingUntil = time.clock.now();
  for (let step = 0; step < 4; step++) {
    time.advance(3_000);
    await tick();
  }
  const acted = await acting;
  expect(acted.text).toMatch(/Waited \d+ s while the person used Calculator\./);
  expect((await acts(ops)).length).toBe(2);
});

it("an agent's click is the pointer viewers draw for that app", async () => {
  const time = coworkClock();
  const cowork = new ScreenCowork({ clock: time.clock });
  const { call } = await world({ toolkit: { cowork } });
  await call("screen_state", { app: "Calculator" });
  await call("screen_act", { app: "Calculator", actions: [{ type: "click", x: 40, y: 60 }] });
  expect(cowork.pointer(["com.apple.calculator"])).toEqual({
    x: 40,
    y: 60,
    kind: "click",
    at: time.clock.now(),
  });
});

it("failed and skipped steps never move the agent pointer to an unexecuted point", async () => {
  const time = coworkClock();
  const cowork = new ScreenCowork({ clock: time.clock });
  const { call } = await world({ toolkit: { cowork } });
  await call("screen_state", { app: "Calculator" });
  await call("screen_act", {
    app: "Calculator",
    actions: [
      { type: "click", x: 10, y: 20 },
      { type: "menu", path: ["Fiel", "New"] },
      { type: "click", x: 90, y: 100 },
    ],
  });
  expect(cowork.pointer(["com.apple.calculator"])).toMatchObject({ x: 10, y: 20 });
  await call("screen_act", {
    app: "Calculator",
    actions: [
      { type: "if", text: "Save changes?" },
      { type: "click", x: 90, y: 100 },
    ],
  });
  expect(cowork.pointer(["com.apple.calculator"])).toMatchObject({ x: 10, y: 20 });
});

it("a person's exclusive app control refuses actions but allows reads and another app", async () => {
  const { call, ops } = await world({
    toolkit: { personExclusive: (appId) => appId === "com.apple.calculator" },
  });
  const looked = await call("screen_state", { app: "Calculator" });
  expect(looked.text).toContain("button 7");
  const refused = await call("screen_act", {
    app: "Calculator",
    actions: [{ type: "key", key: "Escape" }],
  });
  expect(refused.result.isError).toBe(true);
  expect(JSON.parse(refused.text)).toMatchObject({ code: "person_driving" });
  expect(await acts(ops)).toEqual([]);
  const other = await call("screen_act", {
    app: "TextEdit",
    actions: [{ type: "key", key: "Escape" }],
  });
  expect(other.result.isError).toBeFalsy();
  expect(await acts(ops)).toHaveLength(1);
});

it("taking exclusive control during a cowork wait prevents the waiting action from dispatching", async () => {
  const time = coworkClock();
  const cowork = new ScreenCowork({ clock: time.clock });
  let exclusive = false;
  const { call, ops } = await world({ toolkit: { cowork, personExclusive: () => exclusive } });
  await call("screen_state", { app: "Calculator" });
  cowork.personInput(["com.apple.calculator"]);
  const acting = call("screen_act", {
    app: "Calculator",
    actions: [{ type: "key", key: "Escape" }],
  });
  await time.sleeping();
  exclusive = true;
  time.advance(3_000);
  const refused = await acting;
  expect(refused.result.isError).toBe(true);
  expect(JSON.parse(refused.text)).toMatchObject({ code: "person_driving" });
  expect(await acts(ops)).toEqual([]);
});

it("exclusive control is rechecked after locked-use preparation immediately before dispatch", async () => {
  let exclusive = false;
  let takeOver = false;
  const { call, ops } = await world({
    toolkit: {
      personExclusive: () => exclusive,
      lockedUse: async (scope, send) => {
        if (takeOver) exclusive = true;
        return send(scope.signal);
      },
    },
  });
  await call("screen_state", { app: "Calculator" });
  takeOver = true;
  const refused = await call("screen_act", {
    app: "Calculator",
    actions: [{ type: "key", key: "Escape" }],
  });
  expect(refused.result.isError).toBe(true);
  expect(JSON.parse(refused.text)).toMatchObject({ code: "person_driving" });
  expect(await acts(ops)).toEqual([]);
});

it.each([false, true])(
  "a native queued action rechecks the person at dispatch (exclusive %s)",
  async (takeover) => {
    const time = coworkClock();
    const cowork = new ScreenCowork({ clock: time.clock });
    const gate = await helperGate();
    cleanups.push(gate.close);
    let exclusive = false;
    let armed = false;
    const queued = deferred<void>();
    const { call, ops } = await world({
      env: { FAKE_ACT_GATE_PORT: gate.port },
      toolkit: {
        cowork,
        personExclusive: () => exclusive,
        lockedUse: async (scope, send) => {
          const result = send(scope.signal);
          if (armed) queued.resolve();
          return result;
        },
      },
    });
    await call("screen_state", { app: "Calculator" });
    const first = call("screen_act", {
      app: "Calculator",
      actions: [{ type: "key", key: "Escape" }],
    });
    await gate.reached;
    armed = true;
    const second = call("screen_act", {
      app: "Calculator",
      actions: [{ type: "type", text: "2" }],
    });
    await queued.promise;
    armed = false;
    cowork.personInput(["com.apple.calculator"]);
    exclusive = takeover;
    gate.release();
    await first;
    // A read passes the parked action, proving it released the native queue slot.
    const read = await call("screen_state", { app: "Calculator" });
    expect(read.result.isError).toBeFalsy();
    expect(await acts(ops)).toHaveLength(1);
    if (takeover) {
      expect(JSON.parse((await second).text)).toMatchObject({ code: "person_driving" });
    } else {
      time.advance(3_000);
      const result = await second;
      expect(result.result.isError).toBeFalsy();
      expect(result.text).toContain("Waited 3 s while the person used Calculator.");
      expect(await acts(ops)).toHaveLength(2);
    }
  },
);

it("person input during locked-use preparation is checked before native dispatch", async () => {
  const time = coworkClock();
  const cowork = new ScreenCowork({ clock: time.clock });
  let armed = false;
  const { call, ops } = await world({
    toolkit: {
      cowork,
      lockedUse: async (scope, send) => {
        if (armed) cowork.personInput(["com.apple.calculator"]);
        return send(scope.signal);
      },
    },
  });
  await call("screen_state", { app: "Calculator" });
  armed = true;
  const acting = call("screen_act", { app: "Calculator", actions: [{ type: "type", text: "1" }] });
  // The read queues after the act, then passes it once its dispatch gate yields.
  await tick();
  armed = false;
  await call("screen_state", { app: "Calculator" });
  expect(await acts(ops)).toEqual([]);
  time.advance(3_000);
  expect((await acting).result.isError).toBeFalsy();
  expect(await acts(ops)).toHaveLength(1);
});

it("native queue retries keep the original minute budget", async () => {
  const time = coworkClock();
  const cowork = new ScreenCowork({ clock: time.clock });
  const gate = await helperGate();
  cleanups.push(gate.close);
  let armed = false;
  const queued = deferred<void>();
  const { call, ops } = await world({
    env: { FAKE_ACT_GATE_PORT: gate.port },
    toolkit: {
      cowork,
      lockedUse: async (scope, send) => {
        const result = send(scope.signal);
        if (armed) queued.resolve();
        return result;
      },
    },
  });
  await call("screen_state", { app: "Calculator" });
  const first = call("screen_act", {
    app: "Calculator",
    actions: [{ type: "key", key: "Escape" }],
  });
  await gate.reached;
  armed = true;
  const second = call("screen_act", { app: "Calculator", actions: [{ type: "type", text: "2" }] });
  await queued.promise;
  armed = false;
  time.advance(58_000);
  cowork.personInput(["com.apple.calculator"]);
  gate.release();
  await first;
  await call("screen_state", { app: "Calculator" });
  time.advance(2_000);
  expect(JSON.parse((await second).text)).toMatchObject({ code: "person_busy" });
  expect(await acts(ops)).toHaveLength(1);
});

it("a helper exiting during dispatch sampling fails promptly and the next read restarts it", async () => {
  const time = coworkClock();
  const sampled = deferred<void>();
  const release = deferred<void>();
  let hold = false;
  let armed = false;
  const cowork = new ScreenCowork({
    clock: time.clock,
    physical: {
      lastInputAt: async () => {
        if (hold) {
          sampled.resolve();
          await release.promise;
        }
        return undefined;
      },
      frontmost: async () => undefined,
    },
  });
  cleanups.push(() => release.resolve());
  const { call, client, children, exited, ops } = await world({
    toolkit: {
      cowork,
      lockedUse: async (scope, send) => {
        if (armed) hold = true;
        return send(scope.signal);
      },
    },
  });
  await call("screen_state", { app: "Calculator" });
  const pid = await client.helperProcessId("com.apple.calculator");
  const child = children.find((entry) => entry.pid === pid);
  if (!child) throw new Error("Missing app helper");
  armed = true;
  const acting = call("screen_act", {
    app: "Calculator",
    actions: [{ type: "key", key: "Escape" }],
  });
  await sampled.promise;
  child.kill();
  await exited(child);
  hold = false;
  armed = false;
  release.resolve();
  expect((await acting).text).toContain("helper stopped");
  expect(await acts(ops)).toEqual([]);
  expect((await call("screen_state", { app: "Calculator" })).result.isError).toBeFalsy();
});
