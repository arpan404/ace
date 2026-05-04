import { describe, expect, it } from "vitest";

import { resolveBrowserShortcutAction } from "./browserShortcuts";

function input(overrides: Partial<Electron.Input> = {}): Electron.Input {
  return {
    alt: false,
    code: "",
    control: false,
    isAutoRepeat: false,
    isComposing: false,
    key: "r",
    location: 0,
    meta: false,
    modifiers: [],
    shift: false,
    type: "keyDown" as const,
    ...overrides,
  };
}

describe("resolveBrowserShortcutAction", () => {
  it("accepts rawKeyDown events for modified browser shortcuts", () => {
    expect(
      resolveBrowserShortcutAction(
        input({
          key: "r",
          meta: true,
          type: "rawKeyDown",
        }),
        "darwin",
      ),
    ).toBe("reload");
  });

  it("keeps forwarding tab movement and annotation shortcuts with option-modified input", () => {
    expect(
      resolveBrowserShortcutAction(
        input({
          alt: true,
          key: "[",
          meta: true,
        }),
        "darwin",
      ),
    ).toBe("move-tab-left");
    expect(
      resolveBrowserShortcutAction(
        input({
          alt: true,
          key: "1",
          meta: true,
        }),
        "darwin",
      ),
    ).toBe("designer-area-comment");
    expect(
      resolveBrowserShortcutAction(
        input({
          alt: true,
          key: "2",
          meta: true,
        }),
        "darwin",
      ),
    ).toBe("designer-element-comment");
    expect(
      resolveBrowserShortcutAction(
        input({
          alt: true,
          key: "4",
          meta: true,
        }),
        "darwin",
      ),
    ).toBeNull();
  });

  it("ignores unmodified keys", () => {
    expect(resolveBrowserShortcutAction(input({ key: "r" }), "darwin")).toBeNull();
  });
});
