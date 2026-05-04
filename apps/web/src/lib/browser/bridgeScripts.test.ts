import { describe, expect, it } from "vitest";

import {
  buildBrowserCuaActionScript,
  buildBrowserDomCuaActionScript,
  buildBrowserDomSnapshotScript,
  buildBrowserPlaywrightDomSnapshotScript,
} from "./bridgeScripts";

function expectValidInjectedScript(script: string): void {
  expect(() => new Function(script)).not.toThrow();
}

describe("browser bridge scripts", () => {
  it("builds valid injected scripts for DOM snapshots and scroll actions", () => {
    expectValidInjectedScript(buildBrowserDomSnapshotScript());
    expectValidInjectedScript(buildBrowserPlaywrightDomSnapshotScript());
    expectValidInjectedScript(buildBrowserCuaActionScript("scroll", {}));
    expectValidInjectedScript(buildBrowserDomCuaActionScript("scroll", {}));
  });

  it("returns a Playwright-style DOM snapshot script with readable page text", () => {
    const script = buildBrowserPlaywrightDomSnapshotScript();

    expect(script).toContain("collectDomSnapshotText");
    expect(script).toContain("h1");
    expect(script).toContain("p");
    expect(script).toContain("viewport");
  });
});
