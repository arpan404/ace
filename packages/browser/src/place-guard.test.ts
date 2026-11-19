import { expect, it } from "vitest";
import { CdpConnection } from "./cdp-connection.ts";
import { LOCATION_PROBE, holdTo } from "./place-guard.ts";
import { UserChromeLink } from "./user-chrome-link.ts";

/** Whether a sent command is ace asking the page where it is. */
const probing = (params?: { expression?: unknown }) => params?.expression === LOCATION_PROBE;

/**
 * A connection whose browser answers every command at once, the page answering where it is
 * from `page`; the page commands that left for it, in order.
 */
function browser(page: { url: string } = { url: "https://docs.example/guide" }) {
  const wire: { method: string; type?: unknown }[] = [];
  const cdp: CdpConnection = new CdpConnection({
    write: (message) => {
      const sent: {
        id: number;
        method: string;
        params?: { type?: unknown; expression?: unknown };
      } = JSON.parse(message);
      const result = probing(sent.params) ? { result: { value: page.url } } : {};
      if (!probing(sent.params)) wire.push({ method: sent.method, type: sent.params?.type });
      queueMicrotask(() => cdp.receive(JSON.stringify({ id: sent.id, result })));
    },
    schedule: (work, milliseconds) => {
      const timer = setTimeout(work, milliseconds);
      return () => clearTimeout(timer);
    },
    hung: () => {},
  });
  return { cdp, wire };
}

const mouse = (type: string) => ({ type, x: 10, y: 10, button: "left", clickCount: 1 });

/**
 * A tab whose page the test moves (`at`, what the page answers), and the check a held command
 * runs. The browser's own report lags, as a real one does: it still says /guide, so only the
 * page's answer can show the move.
 */
function tab() {
  const at = { url: "https://docs.example/guide" };
  const reported = "https://docs.example/guide";
  const check = (url?: string) => {
    if ((url ?? reported) !== "https://docs.example/guide")
      throw Object.assign(new Error("place changed"), { code: "place_changed" });
  };
  return { at, check };
}

it("a move that changes the page's route keeps the press and release that follow off it", async () => {
  const { at, check } = tab();
  const { cdp, wire } = browser(at);
  const page = cdp.session("page-1");
  await holdTo(check, async () => {
    await page.send("Input.dispatchMouseEvent", mouse("mouseMoved"));
    // The page's mousemove handler routes it to /settings.
    at.url = "https://docs.example/settings";
    await expect(
      page.send("Input.dispatchMouseEvent", mouse("mousePressed")),
    ).rejects.toMatchObject({ code: "place_changed" });
  });
  expect(wire).toEqual([{ method: "Input.dispatchMouseEvent", type: "mouseMoved" }]);
});

it("a press that changes the page's route never lets its release reach the new page", async () => {
  const { at, check } = tab();
  const { cdp, wire } = browser(at);
  // Any of the connection's sessions is checked the same way.
  const frame = cdp.session("frame-7");
  await holdTo(check, async () => {
    await frame.send("Input.dispatchMouseEvent", mouse("mousePressed"));
    at.url = "https://docs.example/checkout";
    await expect(
      frame.send("Input.dispatchMouseEvent", mouse("mouseReleased")),
    ).rejects.toMatchObject({ code: "place_changed" });
  });
  // No mouseup (so no click) reached /checkout; a drag the press began is cancelled.
  expect(wire).toEqual([
    { method: "Input.dispatchMouseEvent", type: "mousePressed" },
    { method: "Input.cancelDragging", type: undefined },
  ]);
});

it("a key whose keydown changes the page never sends its keyup there", async () => {
  const { at, check } = tab();
  const { cdp, wire } = browser(at);
  const page = cdp.session("page-1");
  await holdTo(check, async () => {
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space" });
    at.url = "https://docs.example/settings";
    await expect(
      page.send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space" }),
    ).rejects.toMatchObject({ code: "place_changed" });
  });
  expect(wire).toEqual([{ method: "Input.dispatchKeyEvent", type: "keyDown" }]);
});

it("input outside a held command, as the person's own, is never held to an agent's place", async () => {
  const { at, check } = tab();
  const { cdp, wire } = browser(at);
  const page = cdp.session("page-1");
  at.url = "https://docs.example/settings";
  // A held command elsewhere doesn't reach this input's context.
  const held = holdTo(check, async () => {});
  await page.send("Input.dispatchMouseEvent", mouse("mousePressed"));
  await page.send("Input.dispatchMouseEvent", mouse("mouseReleased"));
  await held;
  expect(wire.map((each) => each.type)).toEqual(["mousePressed", "mouseReleased"]);
  // Reads inside a held command are never refused.
  await holdTo(check, () => page.send("Runtime.evaluate", { expression: "1" }));
  expect(wire.at(-1)).toEqual({ method: "Runtime.evaluate", type: undefined });
});

it("a held input waiting for a free slot checks the place when it leaves, not when it queued", async () => {
  const wire: { id: number; method: string }[] = [];
  const { at, check } = tab();
  const cdp: CdpConnection = new CdpConnection({
    write: (message) => {
      const sent: { id: number; method: string; params?: { expression?: unknown } } =
        JSON.parse(message);
      // The page answers where it is at once; nothing else is answered until the test says.
      if (probing(sent.params))
        queueMicrotask(() =>
          cdp.receive(JSON.stringify({ id: sent.id, result: { result: { value: at.url } } })),
        );
      else wire.push({ id: sent.id, method: sent.method });
    },
    schedule: (work, milliseconds) => {
      const timer = setTimeout(work, milliseconds);
      return () => clearTimeout(timer);
    },
    hung: () => {},
  });
  const page = cdp.session("page-1");
  // Every slot is taken by a command the browser hasn't answered yet.
  const busy = Array.from({ length: 256 }, () =>
    page.send("Runtime.evaluate", { expression: "1" }),
  );
  // Checked as /guide, the press queues behind them.
  const pressing = holdTo(check, () =>
    page.send("Input.dispatchMouseEvent", mouse("mousePressed")),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(wire).toHaveLength(256);
  // The page moves on while it waits; then a slot frees.
  at.url = "https://docs.example/settings";
  const first = wire[0];
  if (!first) throw new Error("nothing sent");
  cdp.receive(JSON.stringify({ id: first.id, result: {} }));
  await expect(pressing).rejects.toMatchObject({ code: "place_changed" });
  expect(wire.filter((each) => each.method.startsWith("Input."))).toEqual([]);
  for (const each of wire) cdp.receive(JSON.stringify({ id: each.id, result: {} }));
  await Promise.all(busy);
});

it("the person's own Chrome checks a queued held input when it leaves, too", async () => {
  const sent: { id: string; method: string }[] = [];
  const { at, check } = tab();
  const link: UserChromeLink = new UserChromeLink({
    connectionId: "c1",
    browser: { family: "chrome", version: "140", profileId: "p1", extensionVersion: "1" },
    connectedAt: 0,
    transport: {
      send: (message) => {
        if (message.type !== "user_browser.command" || message.operation.op !== "cdp") return true;
        const id = message.id;
        if (message.operation.params?.["expression"] === LOCATION_PROBE)
          queueMicrotask(() =>
            link.handle({
              type: "user_browser.reply",
              id,
              ok: true,
              result: { result: { value: at.url } },
            }),
          );
        else sent.push({ id, method: message.operation.method });
        return true;
      },
      close: () => {},
    },
    clock: {
      now: () => 0,
      set: () => () => {},
    },
  });
  const page = link.tab(7);
  const busy = Array.from({ length: 64 }, () => page.send("Runtime.evaluate", {}));
  const pressing = holdTo(check, () =>
    page.send("Input.dispatchMouseEvent", mouse("mousePressed")),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(sent).toHaveLength(64);
  at.url = "https://docs.example/settings";
  const reply = (id: string) =>
    link.handle({ type: "user_browser.reply", id, ok: true, result: {} });
  const first = sent[0];
  if (!first) throw new Error("nothing sent");
  reply(first.id);
  await expect(pressing).rejects.toMatchObject({ code: "place_changed" });
  expect(sent.filter((each) => each.method.startsWith("Input."))).toEqual([]);
  for (const each of sent) reply(each.id);
  await Promise.all(busy);
});

it("every way a page command leaves ace's browser passes the hold, or the guarded session it rides", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const dir = new URL(".", import.meta.url);
  // Handing a CDP command, or an input sent as an operation, to a wire.
  const wire = [
    /op: "cdp"/,
    /kind: "cdp"/,
    /kind: "press"/,
    /kind: "navigate"/,
    /private transmit\(/,
    /"ace\.tabs\.cdp"/,
  ];
  // Those that send through another backend session's own `send`, already held there.
  const riding: Record<string, string> = {
    "embedded-tabs.ts": "embedded.ts",
    "embedded-downloads.ts": "embedded.ts",
  };
  const sources = (await readdir(dir)).filter(
    (name) => name.endsWith(".ts") && !/test|support/.test(name),
  );
  const wires: string[] = [];
  for (const name of sources) {
    const text = await readFile(new URL(name, dir), "utf8");
    if (!wire.some((pattern) => pattern.test(text))) continue;
    wires.push(name);
    const through = riding[name] ?? name;
    const guard = await readFile(new URL(through, dir), "utf8");
    expect(
      /from "\.\/place-guard\.ts"/.test(guard) &&
        /\b(dispatched|beforeInputOperation)\(/.test(guard),
      `${name} sends page commands without the hold`,
    ).toBe(true);
  }
  // A new way out must be added here, after its commands pass the hold.
  expect(wires.toSorted()).toEqual([
    "cdp-connection.ts",
    "embedded-downloads.ts",
    "embedded-tabs.ts",
    "embedded.ts",
    "user-chrome-link.ts",
  ]);
});
