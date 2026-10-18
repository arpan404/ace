import type { BrowserInput } from "@ace/protocol";
import type { BrowserCdp } from "./backend.ts";
import { keyEvent } from "./keyboard.ts";

type KeyInput = Extract<BrowserInput, { kind: "key" }>;
const modifierBits = new Map([
  ["Alt", 1],
  ["Control", 2],
  ["Meta", 4],
  ["Shift", 8],
]);
const namedCodes = new Map([
  [" ", "Space"],
  ["Space", "Space"],
]);

function code(key: string): string | undefined {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^\d$/.test(key)) return `Digit${key}`;
  return namedCodes.get(key);
}

/**
 * Pure translation of an agent's key chord ("Enter", "Shift+Tab", "Control+a", "ControlOrMeta+c")
 * into the CDP key events a person typing it would produce: modifiers down, key down and up,
 * modifiers up.
 */
export function keyChord(chord: string, platform: NodeJS.Platform): KeyInput[] {
  if (!chord || chord.length > 256) throw new Error("Unsupported browser key");
  const plus = chord === "+" || chord.endsWith("++");
  const head = plus ? chord.slice(0, -2) : chord;
  const parts = head ? head.split("+") : [];
  const named = plus ? "+" : parts.pop();
  if (!named) throw new Error("Unsupported browser key");
  const modifiers: string[] = [];
  for (const part of parts) {
    const name = part === "ControlOrMeta" ? (platform === "darwin" ? "Meta" : "Control") : part;
    if (!modifierBits.has(name) || modifiers.includes(name))
      throw new Error("Unsupported browser key");
    modifiers.push(name);
  }
  const shifted = modifiers.includes("Shift") && /^[a-z]$/.test(named);
  const key = named === "Space" ? " " : shifted ? named.toUpperCase() : named;
  const events: KeyInput[] = [];
  let held = 0;
  for (const modifier of modifiers) {
    held |= modifierBits.get(modifier) ?? 0;
    events.push({ kind: "key", event: "keyDown", key: modifier, modifiers: held });
  }
  const keyCode = code(key);
  const plain = !(held & 7);
  events.push({
    kind: "key",
    event: "keyDown",
    key,
    ...(keyCode ? { code: keyCode } : {}),
    // Enter types a carriage return, which drives implicit form submission.
    ...(key === "Enter" && plain ? { text: "\r" } : {}),
    modifiers: held,
  });
  events.push({
    kind: "key",
    event: "keyUp",
    key,
    ...(keyCode ? { code: keyCode } : {}),
    modifiers: held,
  });
  for (const modifier of modifiers.toReversed()) {
    held &= ~(modifierBits.get(modifier) ?? 0);
    events.push({ kind: "key", event: "keyUp", key: modifier, modifiers: held });
  }
  return events;
}

/** Agent pointer and keyboard input over a tab's CDP session. */
export function chromeInput(cdp: () => BrowserCdp, platform: NodeJS.Platform) {
  let pointer = { x: 0, y: 0 };
  const mouse = (type: string, x: number, y: number) =>
    cdp().send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: type === "mouseMoved" ? "none" : "left",
      ...(type === "mouseMoved" ? {} : { clickCount: 1 }),
    });
  return {
    async click(x: number, y: number) {
      pointer = { x, y };
      await mouse("mouseMoved", x, y);
      await mouse("mousePressed", x, y);
      await mouse("mouseReleased", x, y);
    },
    async wheel(deltaX: number, deltaY: number) {
      await cdp().send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: pointer.x,
        y: pointer.y,
        deltaX,
        deltaY,
      });
    },
    async insertText(text: string) {
      await cdp().send("Input.insertText", { text });
    },
    async press(chord: string) {
      for (const input of keyChord(chord, platform))
        await cdp().send("Input.dispatchKeyEvent", keyEvent(input));
    },
  };
}
