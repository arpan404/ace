import { describe, expect, it } from "vitest";
import { claimKeychainName, keychainName, type NamedApp } from "./keychain.ts";

/** Electron's `app` as far as naming goes: the data folder defaults from the name. */
function fakeApp(name: string) {
  let current = name;
  let userData: string | undefined;
  let ready!: () => void;
  const whenReady = new Promise<void>((resolve) => (ready = resolve));
  const app: NamedApp = {
    getName: () => current,
    setName: (next) => (current = next),
    getPath: () => userData ?? `/Users/me/Library/Application Support/${current}`,
    setPath: (_name, path) => (userData = path),
    whenReady: () => whenReady,
  };
  return { app, ready };
}

describe("keychain name", () => {
  it("starts Chromium under a name that is not the older ace app's keychain item", () => {
    const { app } = fakeApp("ace");
    claimKeychainName(app, "darwin");
    expect(app.getName()).toBe(keychainName);
    expect(`${app.getName()} Safe Storage`).not.toBe("ace Safe Storage");
  });

  it("keeps the app's data folder where its own name puts it", () => {
    const { app } = fakeApp("ace");
    claimKeychainName(app, "darwin");
    expect(app.getPath("userData")).toBe("/Users/me/Library/Application Support/ace");
  });

  it("gives the app its own name back once it is ready", async () => {
    const { app, ready } = fakeApp("ace");
    claimKeychainName(app, "darwin");
    ready();
    await app.whenReady();
    await Promise.resolve();
    expect(app.getName()).toBe("ace");
  });

  it("leaves other platforms alone", () => {
    const { app } = fakeApp("ace");
    claimKeychainName(app, "win32");
    expect(app.getName()).toBe("ace");
  });
});
