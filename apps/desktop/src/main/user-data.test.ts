import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { desktopLogs, desktopUserData } from "./user-data.ts";

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

describe("the app's logs folder", () => {
  it("is inside ACE_DESKTOP_USER_DATA when set, so a dev or test app keeps out of the real logs", () => {
    const explicit = join(sep, "tmp", "ace-e2e-1");
    expect(desktopLogs(explicit)).toBe(join(explicit, "logs"));
  });

  it("stays the system's logs folder otherwise", () => {
    expect(desktopLogs(undefined)).toBeUndefined();
  });
});
