import { expect, test } from "vitest";
import { keyOwner, type KeyLike } from "./keys.ts";

const press = (keys: string): KeyLike => {
  const parts = keys.split("+");
  const key = parts.at(-1) ?? "";
  return {
    key,
    code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key === "`" ? "Backquote" : key,
    ctrlKey: parts.includes("ctrl"),
    metaKey: parts.includes("cmd"),
    shiftKey: parts.includes("shift"),
    altKey: parts.includes("alt"),
  };
};

test("the shell keeps its control keys on every platform, even where they are ace shortcuts", () => {
  for (const apple of [true, false])
    for (const keys of ["ctrl+c", "ctrl+r", "ctrl+p", "ctrl+k", "ctrl+j", "ctrl+n", "ctrl+b"])
      expect(keyOwner(press(keys), apple), `${keys} on ${apple ? "Mac" : "PC"}`).toBe("terminal");
});

test("plain and Alt keys go to the shell", () => {
  expect(keyOwner(press("a"), true)).toBe("terminal");
  expect(keyOwner(press("alt+b"), false)).toBe("terminal");
});

test("⌘ shortcuts stay ace's on a Mac, apart from copy, paste and find", () => {
  expect(keyOwner(press("cmd+k"), true)).toBe("app");
  expect(keyOwner(press("cmd+j"), true)).toBe("app");
  expect(keyOwner(press("cmd+c"), true)).toBe("copy");
  expect(keyOwner(press("cmd+v"), true)).toBe("paste");
  expect(keyOwner(press("cmd+f"), true)).toBe("find");
});

test("elsewhere, copy, paste and find are Ctrl+Shift+C, V and F, and other Ctrl+Shift keys are ace's", () => {
  expect(keyOwner(press("ctrl+shift+c"), false)).toBe("copy");
  expect(keyOwner(press("ctrl+shift+v"), false)).toBe("paste");
  expect(keyOwner(press("ctrl+shift+f"), false)).toBe("find");
  expect(keyOwner(press("ctrl+shift+a"), false)).toBe("app");
  expect(keyOwner(press("ctrl+alt+t"), false)).toBe("app");
});

test("Ctrl+` always leaves the terminal, so focus is never trapped", () => {
  for (const apple of [true, false]) {
    expect(keyOwner(press("ctrl+`"), apple)).toBe("app");
    expect(keyOwner(press("ctrl+shift+`"), apple)).toBe("app");
  }
});
