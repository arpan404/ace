import { expect, test } from "vitest";
import { join } from "node:path";
import {
  CursorAuthService,
  ProviderLoginSessions,
  createInstance,
  openRegistry,
} from "@ace/accounts";
import type { ProviderLoginProgress } from "@ace/protocol";
import { cursorLoginDriver } from "./provider-login-cursor.ts";
import { fixture } from "./socket-test-support.ts";

test.each(["complete", "cancel", "unsafe_url"])(
  "Cursor SDK %s uses its existing auth owner without exposing credential-bearing data",
  async (mode) => {
    const f = await fixture();
    const registry = await openRegistry(join(f.home, "accounts.sqlite"));
    const finish = Promise.withResolvers<void>();
    let sequence = 0;
    const auth = new CursorAuthService({
      registry,
      now: () => 1000,
      id: () => `sdk-login-${++sequence}`,
      setTimer: () => () => {},
      createInstance: async (id, label) =>
        createInstance({ id, label, provider: "cursor", homeDir: join(f.home, "sdk-instance") }),
      rebindInstance: async () => {},
      driver: {
        checkAvailability: async () => {},
        status: async () => ({ status: "logged-out", source: "none" }),
        logout: async () => ({ status: "logged-out", source: "none" }),
        async login(_instance, signal, emit) {
          emit(
            mode === "unsafe_url"
              ? "https://cursor.com/login?access_token=sk-SYNTHETIC0123456789"
              : "https://cursor.com/login?challenge=public-challenge",
          );
          await new Promise<void>((resolve, reject) => {
            const abort = () => reject(new Error("SDK login cancelled"));
            signal.addEventListener("abort", abort, { once: true });
            void finish.promise.then(() => {
              signal.removeEventListener("abort", abort);
              resolve();
            });
            if (signal.aborted) abort();
          });
          return { status: "logged-in", source: "sdk-store" };
        },
      },
    });
    const sessions = new ProviderLoginSessions({
      now: () => 1000,
      id: () => "provider-login",
      schedule: () => () => {},
      prepare: async (_target, action, _signal, owner) =>
        cursorLoginDriver(auth, owner, "sdk-default", action, () => `request-${++sequence}`),
    });
    const browser = Promise.withResolvers<void>();
    const done = Promise.withResolvers<ProviderLoginProgress>();
    const events: ProviderLoginProgress[] = [];
    sessions.listen((_owner, progress) => {
      events.push(progress);
      if (progress.state === "awaiting_browser") browser.resolve();
      if (["succeeded", "failed", "cancelled"].includes(progress.state)) done.resolve(progress);
    });
    try {
      await sessions.handle("phone", {
        type: "provider.login.start",
        requestId: "start",
        provider: "cursor",
      });
      if (mode !== "unsafe_url") {
        await browser.promise;
        if (mode === "complete") finish.resolve();
        else
          await sessions.handle("phone", {
            type: "provider.login.cancel",
            requestId: "cancel",
            session: "provider-login",
          });
      }
      expect(await done.promise).toMatchObject({
        state: mode === "complete" ? "succeeded" : mode === "cancel" ? "cancelled" : "failed",
      });
      expect(JSON.stringify(events)).not.toMatch(/access_token|sk-SYNTHETIC/);
    } finally {
      finish.resolve();
      await sessions.close();
      await auth.close();
      registry.close();
      await f.close();
    }
  },
);
