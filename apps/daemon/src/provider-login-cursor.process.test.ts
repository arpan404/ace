import { expect, test } from "vitest";
import { join } from "node:path";
import { readFile, writeFile, rm } from "node:fs/promises";
import { ProviderLoginSessions, createInstance, openRegistry } from "@ace/accounts";
import type { ProviderLoginProgress } from "@ace/protocol";
import { cursorLoginDriver } from "./provider-login-cursor.ts";
import { fixture } from "./socket-test-support.ts";

test.each(["complete", "failed", "cancel", "unsafe_url"])(
  "Cursor SDK %s uses its existing auth owner without exposing credential-bearing data",
  async (mode) => {
    const f = await fixture();
    const registry = await openRegistry(join(f.home, "accounts.sqlite"));
    const finish = Promise.withResolvers<void>();
    const active = join(f.home, "sdk-login-active");
    const instance = createInstance({
      id: "sdk-default",
      label: "Cursor",
      provider: "cursor",
      homeDir: join(f.home, "sdk-instance"),
    });
    await registry.register(instance);
    const account = {
      logout: async () => ({ status: "logged-out" as const, source: "none" as const }),
      async login(_instance: typeof instance, signal: AbortSignal, emit: (url: string) => void) {
        await writeFile(active, "SDK login is running");
        try {
          emit(
            mode === "unsafe_url"
              ? "https://cursor.com/login?access_token=sk-SYNTHETIC0123456789"
              : "https://cursor.com/loginDeepControl?challenge=public-challenge&redirectTarget=sdk",
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
          if (mode === "failed") throw new Error("private-sdk-failure");
          return { status: "logged-in" as const, source: "sdk-store" as const };
        } finally {
          await rm(active);
        }
      },
    };
    const sessions = new ProviderLoginSessions({
      now: () => 1000,
      id: () => "provider-login",
      schedule: () => () => {},
      prepare: async (_target, action) => cursorLoginDriver(instance, account, action),
    });
    const browser = Promise.withResolvers<ProviderLoginProgress>();
    const done = Promise.withResolvers<ProviderLoginProgress>();
    const events: ProviderLoginProgress[] = [];
    sessions.listen((_owner, progress) => {
      events.push(progress);
      if (progress.state === "awaiting_browser") browser.resolve(progress);
      if (["succeeded", "failed", "cancelled"].includes(progress.state)) done.resolve(progress);
    });
    try {
      await sessions.handle("phone", {
        type: "provider.login.start",
        requestId: "start",
        provider: "cursor",
      });
      if (mode !== "unsafe_url") {
        const challenge = await Promise.race([
          browser.promise,
          done.promise.then((progress) => {
            throw new Error(`Cursor login ended before its browser challenge: ${progress.state}`);
          }),
        ]);
        expect(challenge).toMatchObject({
          state: "awaiting_browser",
          url: "https://cursor.com/loginDeepControl?challenge=public-challenge&redirectTarget=sdk",
        });
        expect(await readFile(active, "utf8")).toBe("SDK login is running");
        if (mode === "complete" || mode === "failed") finish.resolve();
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
      await expect(readFile(active)).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.stringify(events)).not.toMatch(/access_token|sk-SYNTHETIC|private-sdk-failure/);
    } finally {
      finish.resolve();
      await sessions.close();
      registry.close();
      await f.close();
    }
  },
);
