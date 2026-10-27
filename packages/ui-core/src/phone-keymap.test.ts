import { describe, expect, it } from "vitest";
import {
  formatPhoneKeys,
  normalizePhoneKeys,
  phoneKeyProblem,
  phoneKeymap,
  phoneReservedKeys,
  resolvePhoneKeymap,
} from "./phone-keymap.ts";

describe("phone keymap", () => {
  it("ships no two shortcuts on the same keys where both work", () => {
    const defaults = resolvePhoneKeymap({});
    for (const entry of phoneKeymap.filter((candidate) => !candidate.fixed))
      expect(phoneKeyProblem(entry.keys, entry.id, defaults)).toBeUndefined();
  });

  it("reads one shortcut the same however its modifiers are spelt", () => {
    expect(normalizePhoneKeys("mod+Shift+K")).toBe("shift+mod+k");
    expect(normalizePhoneKeys("mod+ctrl+s")).toBe(normalizePhoneKeys("ctrl+mod+s"));
  });

  it("refuses keys that would capture typing or are not one key", () => {
    expect(phoneKeyProblem("k", "newThread", resolvePhoneKeymap({}))).toEqual({ kind: "invalid" });
    expect(phoneKeyProblem("shift+k", "newThread", resolvePhoneKeymap({}))).toEqual({
      kind: "invalid",
    });
    expect(phoneKeyProblem("mod+hyper+k", "newThread", resolvePhoneKeymap({}))).toEqual({
      kind: "invalid",
    });
    expect(phoneKeyProblem("mod+", "newThread", resolvePhoneKeymap({}))).toEqual({
      kind: "invalid",
    });
  });

  it("keeps the system's editing keys for the system", () => {
    expect(phoneReservedKeys).toContain("mod+c");
    expect(phoneKeyProblem("mod+C", "newThread", resolvePhoneKeymap({}))).toEqual({
      kind: "reserved",
    });
  });

  it("names the shortcut that already has the keys", () => {
    const bindings = resolvePhoneKeymap({});
    expect(phoneKeyProblem("mod+f", "newThread", bindings)).toEqual({
      kind: "taken",
      by: "searchThreads",
      label: "Search threads",
    });
  });

  it("follows a rebinding when checking for conflicts", () => {
    const bindings = resolvePhoneKeymap({ searchThreads: "mod+k" });
    expect(phoneKeyProblem("mod+f", "newThread", bindings)).toBeUndefined();
    expect(phoneKeyProblem("mod+k", "newThread", bindings)?.kind).toBe("taken");
  });

  it("lets a composer key reuse nothing global but share with no other context", () => {
    const bindings = resolvePhoneKeymap({});
    expect(phoneKeyProblem("mod+n", "send", bindings)).toEqual({
      kind: "taken",
      by: "newThread",
      label: "New thread",
    });
  });

  it("drops unknown, malformed and fixed rebindings", () => {
    const resolved = resolvePhoneKeymap({
      newThread: "mod+t",
      close: "mod+w",
      searchThreads: "nonsense+",
      ghost: "mod+g",
    });
    expect(resolved.newThread).toBe("mod+t");
    expect(resolved.close).toBe("escape");
    expect(resolved.searchThreads).toBe("mod+f");
    expect(resolved).not.toHaveProperty("ghost");
    expect(resolvePhoneKeymap("not an object").newThread).toBe("mod+n");
  });

  it("formats shortcuts as Apple keyboards print them", () => {
    expect(formatPhoneKeys("ctrl+mod+s")).toBe("⌃⌘S");
    expect(formatPhoneKeys("mod+enter")).toBe("⌘Return");
    expect(formatPhoneKeys("escape")).toBe("Esc");
    expect(formatPhoneKeys("shift+alt+mod+]")).toBe("⌥⇧⌘]");
  });
});
