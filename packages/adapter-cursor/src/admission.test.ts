import { expect, it } from "vitest";
import {
  discoverCursorSdk,
  localPolicy,
  cursorSdkEnvironment,
  createCursorAdapter,
} from "./index.ts";
import { boundedJson } from "@ace/provider-kit/ipc";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { ThreadId } from "@ace/protocol";

const options = {
  resolve: (id: string) =>
    id === "@cursor/sdk" ? "/sdk/dist/esm/index.js" : "/helper/package.json",
  read: async (path: string) =>
    path === "/sdk/package.json"
      ? '{"name":"@cursor/sdk","version":"1.0.35"}'
      : path === "/helper/package.json"
        ? '{"name":"@cursor/sdk-darwin-arm64","version":"1.0.35"}'
        : Promise.reject(new Error("missing")),
  executable: async () => {},
  platform: "darwin",
  arch: "arm64",
  nodeVersion: "24.0.0",
};
it("admits an SDK without requiring a CLI and refuses unsupported resolved versions", async () => {
  expect(await discoverCursorSdk(options)).toMatchObject({ installed: true, supported: true });
  expect(
    await discoverCursorSdk({
      ...options,
      read: async (path) => (await options.read(path)).replace("1.0.35", "1.0.36"),
    }),
  ).toMatchObject({ installed: true, supported: false, version: "1.0.36" });
});
it("distinguishes absent SDK from a broken installation and refuses Windows supervision", async () => {
  expect(await discoverCursorSdk({ ...options, nodeVersion: "malformed" })).toMatchObject({
    installed: true,
    supported: false,
  });
  expect(
    await discoverCursorSdk({ ...options, read: async () => "x".repeat(65537) }),
  ).toMatchObject({
    installed: true,
    supported: false,
  });
  const missing = Object.assign(new Error("missing"), { code: "MODULE_NOT_FOUND" });
  expect(
    await discoverCursorSdk({
      resolve: () => {
        throw missing;
      },
    }),
  ).toEqual({ installed: false, supported: false });
  expect(await discoverCursorSdk({ ...options, platform: "win32" })).toMatchObject({
    installed: true,
    supported: false,
  });
  expect(
    await discoverCursorSdk({
      ...options,
      executable: async () => {
        throw new Error("missing helper");
      },
    }),
  ).toMatchObject({ installed: true, supported: false });
});
it("maps full access explicitly and keeps restricted guards when classifier availability is unknown", () => {
  expect(localPolicy("full-access", false)).toMatchObject({
    sandboxOptions: { enabled: false },
    autoReview: false,
  });
  expect(localPolicy("restricted", true)).toMatchObject({
    sandboxOptions: { enabled: true },
    autoReview: true,
  });
  expect(localPolicy("restricted", false)).toMatchObject({
    sandboxOptions: { enabled: true },
    autoReview: true,
  });
});
it("uses the isolated SDK default home and inherits only the Cursor SDK environment auth choice", () => {
  const env = cursorSdkEnvironment(
    { id: "a", homeDir: "/accounts/a" },
    { CURSOR_API_KEY: "sentinel", CURSOR_AUTH_TOKEN: "masked", NODE_OPTIONS: "--import hostile" },
  );
  expect(env.HOME).toBe("/accounts/a/user");
  expect(env.CURSOR_API_KEY).toBe("sentinel");
  expect(env.CURSOR_AUTH_TOKEN).toBeUndefined();
  expect(env.NODE_OPTIONS).toBeUndefined();
});
it("fences oversized, deeply nested and getter-bearing callback data before serialization", () => {
  let getterRead = false;
  const getter = Object.defineProperty({}, "text", {
    enumerable: true,
    get() {
      getterRead = true;
      return "unsafe";
    },
  });
  expect(() => boundedJson(getter)).toThrow("getter");
  expect(getterRead).toBe(false);
  expect(() => boundedJson({ value: "x".repeat(2048) }, 1024)).toThrow("budget");
  let nested: unknown = "end";
  for (let i = 0; i < 80; i++) nested = { next: nested };
  expect(() => boundedJson(nested)).toThrow("structure");
  const payload = new ProviderPayload(boundedJson({ future: { opaque: 9 } }));
  expect(payload.data).toEqual({ future: { opaque: 9 } });
  expect(Object.isFrozen(payload.data)).toBe(true);
});

it("refuses an opaque native fork before SDK admission and requires portable context", async () => {
  const adapter = createCursorAdapter({ instance: { id: "fixture", homeDir: "/fixture" } });
  try {
    await expect(
      adapter.openSession({
        threadId: ThreadId.parse("fresh-thread"),
        cwd: "/fixture",
        signal: new AbortController().signal,
        fork: {
          nativeSessionId: "source-acp-or-task",
          point: { type: "end", nativeId: "source-acp-or-task" },
        },
        onFrame: () => {},
        onExit: () => {},
      }),
    ).rejects.toThrow("fresh ace portable context handoff");
  } finally {
    await adapter.close();
  }
});
