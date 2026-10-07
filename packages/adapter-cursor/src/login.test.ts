import { expect, test } from "vitest";
import { createCursorLoginDriver } from "./index.ts";

const instance = { id: "fixture", homeDir: "/tmp/cursor-login-fixture" };

test("browser sign-in progress exposes a challenge and success without auth data", async () => {
  const finish = Promise.withResolvers<void>();
  const flow = createCursorLoginDriver(instance, {
    async login(_instance, signal, url) {
      signal.throwIfAborted();
      url("https://cursor.com/loginDeepControl?challenge=synthetic&redirectTarget=sdk");
      await finish.promise;
      return { status: "logged-in", source: "sdk-store" };
    },
  }).start(new AbortController().signal);
  expect((await flow.next()).value).toEqual({ state: "starting" });
  expect((await flow.next()).value).toMatchObject({
    state: "browser",
    url: expect.stringContaining("redirectTarget=sdk"),
  });
  finish.resolve();
  expect((await flow.next()).value).toEqual({ state: "complete" });
  expect((await flow.next()).done).toBe(true);
});

test("cancelling a browser exchange drains login and publishes only cancellation", async () => {
  const controller = new AbortController();
  const flow = createCursorLoginDriver(instance, {
    async login(_instance, signal, url) {
      url("https://cursor.com/login?challenge=synthetic");
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("private failure")), {
          once: true,
        }),
      );
      throw new Error("unreachable");
    },
  }).start(controller.signal);
  await flow.next();
  expect((await flow.next()).value?.state).toBe("browser");
  controller.abort();
  expect((await flow.next()).value).toEqual({ state: "cancelled" });
  expect((await flow.next()).done).toBe(true);
});

test("closing the progress consumer aborts and drains its SDK login", async () => {
  const stopped = Promise.withResolvers<void>();
  const flow = createCursorLoginDriver(instance, {
    async login(_instance, signal, url) {
      url("https://cursor.com/login?challenge=synthetic");
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            stopped.resolve();
            reject(new Error("aborted"));
          },
          { once: true },
        ),
      );
      throw new Error("unreachable");
    },
  }).start(new AbortController().signal);
  await flow.next();
  await flow.next();
  await flow.return(undefined);
  await stopped.promise;
});

test("unsafe challenges and SDK diagnostics never reach sign-in progress", async () => {
  for (const value of ["file:///private/auth.json", "https://cursor.com/login\nprivate-secret"]) {
    const states = [];
    for await (const progress of createCursorLoginDriver(instance, {
      async login(_instance, _signal, url) {
        url(value);
        throw new Error("private-secret");
      },
    }).start(new AbortController().signal))
      states.push(progress);
    expect(states).toEqual([{ state: "starting" }, { state: "failed" }]);
  }
});
