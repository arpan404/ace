import { expect, it } from "vitest";
import { CdpConnection } from "./cdp-connection.ts";
import { holdTo } from "./place-guard.ts";

/** A connection whose browser answers every command at once; what left for it, in order. */
function browser() {
  const wire: { method: string; type?: unknown }[] = [];
  const cdp: CdpConnection = new CdpConnection({
    write: (message) => {
      const sent: { id: number; method: string; params?: { type?: unknown } } = JSON.parse(message);
      wire.push({ method: sent.method, type: sent.params?.type });
      queueMicrotask(() => cdp.receive(JSON.stringify({ id: sent.id, result: {} })));
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

/** A tab whose address the test moves, and the check a held command runs against it. */
function tab() {
  const at = { url: "https://docs.example/guide" };
  const check = () => {
    if (at.url !== "https://docs.example/guide")
      throw Object.assign(new Error("place changed"), { code: "place_changed" });
  };
  return { at, check };
}

it("a move that changes the page's route keeps the press and release that follow off it", async () => {
  const { cdp, wire } = browser();
  const page = cdp.session("page-1");
  const { at, check } = tab();
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
  const { cdp, wire } = browser();
  // Any of the connection's sessions: an iframe's is checked the same way.
  const frame = cdp.session("frame-7");
  const { at, check } = tab();
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
  const { cdp, wire } = browser();
  const page = cdp.session("page-1");
  const { at, check } = tab();
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
  const { cdp, wire } = browser();
  const page = cdp.session("page-1");
  const { at, check } = tab();
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
