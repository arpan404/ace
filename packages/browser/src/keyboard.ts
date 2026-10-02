import type { BrowserInput } from "@ace/protocol";

type KeyInput = Extract<BrowserInput, { kind: "key" }>;
const named = new Map<string, number>([
  ["Backspace", 8],
  ["Tab", 9],
  ["Enter", 13],
  ["Shift", 16],
  ["Control", 17],
  ["Alt", 18],
  ["Pause", 19],
  ["CapsLock", 20],
  ["Escape", 27],
  [" ", 32],
  ["PageUp", 33],
  ["PageDown", 34],
  ["End", 35],
  ["Home", 36],
  ["ArrowLeft", 37],
  ["ArrowUp", 38],
  ["ArrowRight", 39],
  ["ArrowDown", 40],
  ["Insert", 45],
  ["Delete", 46],
  ["Meta", 91],
  ["ContextMenu", 93],
  ["NumLock", 144],
  ["ScrollLock", 145],
]);
const punctuation = new Map<string, number>([
  ["Semicolon", 186],
  ["Equal", 187],
  ["Comma", 188],
  ["Minus", 189],
  ["Period", 190],
  ["Slash", 191],
  ["Backquote", 192],
  ["BracketLeft", 219],
  ["Backslash", 220],
  ["BracketRight", 221],
  ["Quote", 222],
  ["Space", 32],
]);

/** Pure translation of validated wire keys to CDP's platform-independent VK codes. */
export function keyEvent(input: KeyInput) {
  let windowsVirtualKeyCode = named.get(input.key);
  let location = 0;
  if (windowsVirtualKeyCode !== undefined) {
    const code = input.code;
    const matching =
      code === undefined ||
      code === input.key ||
      (input.key === " " && code === "Space") ||
      (input.key === "Enter" && code === "NumpadEnter") ||
      (["Shift", "Control", "Alt", "Meta"].includes(input.key) &&
        (code === `${input.key}Left` || code === `${input.key}Right`));
    if (!matching) throw new Error("Browser key/code mismatch");
  } else if (/^F([1-9]|1\d|2[0-4])$/.test(input.key)) {
    if (input.code && input.code !== input.key) throw new Error("Browser key/code mismatch");
    windowsVirtualKeyCode = 111 + Number(input.key.slice(1));
  } else {
    if (Array.from(input.key).length !== 1) throw new Error("Unsupported browser key");
    if (input.code?.match(/^Key[A-Z]$/)) windowsVirtualKeyCode = input.code.charCodeAt(3);
    else if (input.code?.match(/^Digit\d$/)) windowsVirtualKeyCode = input.code.charCodeAt(5);
    else if (input.code?.match(/^Numpad\d$/))
      windowsVirtualKeyCode = 96 + Number(input.code.at(-1));
    else if (input.code) {
      windowsVirtualKeyCode = punctuation.get(input.code);
      if (windowsVirtualKeyCode === undefined) throw new Error("Unsupported browser key code");
    } else if (/^[a-z0-9]$/i.test(input.key))
      windowsVirtualKeyCode = input.key.toUpperCase().charCodeAt(0);
  }
  if (input.code?.startsWith("Numpad")) location = 3;
  else if (input.code?.endsWith("Right") && ["Shift", "Control", "Alt", "Meta"].includes(input.key))
    location = 2;
  else if (input.code?.endsWith("Left") && ["Shift", "Control", "Alt", "Meta"].includes(input.key))
    location = 1;
  return {
    type: input.event,
    key: input.key,
    ...(input.code ? { code: input.code } : {}),
    ...(input.event === "keyUp"
      ? {}
      : {
          text:
            input.text ??
            (input.event === "keyDown" &&
            Array.from(input.key).length === 1 &&
            !(input.modifiers & 7)
              ? input.key
              : ""),
        }),
    ...(windowsVirtualKeyCode === undefined ? {} : { windowsVirtualKeyCode }),
    location,
    modifiers: input.modifiers,
  };
}
