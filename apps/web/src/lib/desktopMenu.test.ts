import { describe, expect, it } from "vitest";

import { resolveDesktopMenuSettingsRoute } from "./desktopMenu";

describe("resolveDesktopMenuSettingsRoute", () => {
  it("maps desktop menu actions to the matching settings routes", () => {
    expect(resolveDesktopMenuSettingsRoute("open-settings")).toBe("/settings/general");
    expect(resolveDesktopMenuSettingsRoute("open-settings-chat")).toBe("/settings/chat");
    expect(resolveDesktopMenuSettingsRoute("open-settings-editor")).toBe("/settings/editor");
    expect(resolveDesktopMenuSettingsRoute("open-settings-browser")).toBe("/settings/general");
    expect(resolveDesktopMenuSettingsRoute("open-settings-models")).toBe("/settings/providers");
    expect(resolveDesktopMenuSettingsRoute("open-settings-providers")).toBe("/settings/providers");
    expect(resolveDesktopMenuSettingsRoute("open-settings-advanced")).toBe("/settings/advanced");
    expect(resolveDesktopMenuSettingsRoute("open-settings-about")).toBe("/settings/about");
    expect(resolveDesktopMenuSettingsRoute("open-settings-archived")).toBe("/settings/archived");
  });

  it("returns null for non-settings menu actions", () => {
    expect(resolveDesktopMenuSettingsRoute("new-thread")).toBeNull();
    expect(resolveDesktopMenuSettingsRoute("toggle-terminal")).toBeNull();
  });
});
