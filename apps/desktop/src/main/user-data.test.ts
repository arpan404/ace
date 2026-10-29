import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { desktopUserData } from "./user-data.ts";

describe("the app's own data folder", () => {
  it("is ace-next under the app data folder, whatever daemon the app talks to", () => {
    const appData = join("Users", "dev", "Library", "Application Support");
    expect(desktopUserData({ explicit: undefined, appData })).toBe(join(appData, "ace-next"));
  });

  it("is ACE_DESKTOP_USER_DATA when set", () => {
    const appData = join("Users", "dev", "Library", "Application Support");
    const explicit = join(sep, "Users", "dev", "work", "electron");
    expect(desktopUserData({ explicit, appData })).toBe(explicit);
  });
});
