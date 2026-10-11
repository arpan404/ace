// @vitest-environment node
import { chromium } from "@playwright/test";
import { expect, test } from "vitest";
import { brokerLeader } from "./broker-leader.ts";

const install = (code: string) => {
  const start = new Function(`return (${code})`)();
  const windowState = { polls: 0, stopped: false };
  Object.assign(globalThis, { windowState });
  start(navigator.locks, "shared-computer", () => {
    windowState.polls++;
    return () => {
      windowState.stopped = true;
    };
  });
};

test("only the leader window polls and a standby takes over after the leader closes", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route("http://localhost/", (route) => route.fulfill({ body: "<html></html>" }));
    const first = await context.newPage();
    const standby = await context.newPage();
    await Promise.all([first.goto("http://localhost/"), standby.goto("http://localhost/")]);
    const source = brokerLeader.toString();
    await first.evaluate(install, source);
    await first.waitForFunction(() => Reflect.get(globalThis, "windowState").polls === 1);
    await standby.evaluate(install, source);
    const locks = await standby.evaluate(() => navigator.locks.query());
    expect(locks.pending?.some((lock) => lock.name === "ace-remote-broker:shared-computer")).toBe(
      true,
    );
    expect(await standby.evaluate(() => Reflect.get(globalThis, "windowState").polls)).toBe(0);
    await first.close();
    await standby.waitForFunction(() => Reflect.get(globalThis, "windowState").polls === 1);
    expect(await standby.evaluate(() => Reflect.get(globalThis, "windowState").polls)).toBe(1);
  } finally {
    await browser.close();
  }
});

test("a browser without leader coordination does not start competing broker polling", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route("http://remote.test/", (route) => route.fulfill({ body: "<html></html>" }));
    const page = await context.newPage();
    await page.goto("http://remote.test/");
    await page.evaluate(install, brokerLeader.toString());
    expect(await page.evaluate(() => Reflect.get(globalThis, "windowState").polls)).toBe(0);
  } finally {
    await browser.close();
  }
});
