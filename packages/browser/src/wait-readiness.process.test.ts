import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { backendFixture } from "./backend-test-support.ts";
import { TestNavigationClock } from "./navigation-test-clock.ts";

it("a URL wait remains pending after destination commit until the destination document is ready", async () => {
  const clock = new TestNavigationClock();
  const f = await backendFixture({ backendPreference: () => "headless", navigationClock: clock });
  await f.open();
  const page = f.headless.pages[0];
  if (!page) throw new Error("Missing page");
  const url = "http://localhost/destination";
  page.url = url;
  let readyState = "loading";
  const probed = Promise.withResolvers<void>();
  const send = page.cdp.send;
  page.cdp.send = async (method, params) => {
    if (method !== "Runtime.evaluate") return send(method, params);
    const result: unknown = runInNewContext(String(params?.["expression"]), {
      location: { href: url },
      document: { readyState },
    });
    probed.resolve();
    return { result: { value: result } };
  };
  let settled = false;
  const wait = f.service.execute("thread", { action: "wait_for", url }).then((result) => {
    settled = true;
    return result;
  });
  await probed.promise;
  // A queued input proves a prematurely successful wait would have observable effects.
  const next = f.service.execute("thread", { action: "press", key: "Enter" });
  await setImmediate();
  expect(settled).toBe(false);
  expect(page.effects).toEqual([]);
  readyState = "interactive";
  clock.advance(50);
  await wait;
  await next;
  expect(page.effects).toEqual(["key"]);
});
