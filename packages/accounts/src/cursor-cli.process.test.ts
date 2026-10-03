import { mkdtemp, rm, readFile, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { CursorAuthService, openRegistry, createInstance, runAccountsCommand } from "./index.ts";
import { cursorDaemonDriver } from "./cursor-cli-auth.ts";

it.each(["status", "login"] as const)(
  "SDK %s surfaces the daemon's error code",
  async (operation) => {
    const driver = cursorDaemonDriver({
      request: async () => ({
        type: "cursor.auth.error",
        requestId: "failure",
        code: "unavailable",
      }),
      wait: async () => {},
      close: async () => {},
    });
    const instance = createInstance({
      id: "fixture",
      provider: "cursor",
      homeDir: "/tmp/sdk-fixture",
      label: "Fixture",
    });
    await expect(
      operation === "status"
        ? driver.status(instance, new AbortController().signal)
        : driver.login(instance, new AbortController().signal, () => {}),
    ).rejects.toThrow(
      `Daemon SDK ${operation === "status" ? "auth status" : "login"} failed: unavailable`,
    );
  },
);

it("a fresh SDK account added through the CLI obtains its browser challenge from the daemon auth flow", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-cli-login-"));
  const canonicalRoot = await realpath(root);
  const alias = join(root, "home-alias");
  await symlink(canonicalRoot, alias, "dir");
  const path = join(root, "accounts.sqlite"),
    registry = await openRegistry(path);
  const browser = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>(),
    rebound = Promise.withResolvers<void>();
  let loggedIn = false,
    id = 0,
    closed = false;
  const output: string[] = [];
  const auth = new CursorAuthService({
    registry,
    now: () => 1,
    id: () => "login-job",
    setTimer: () => () => {},
    createInstance: async (account, label) =>
      createInstance({ id: account, label, provider: "cursor", homeDir: join(root, account) }),
    rebindInstance: async () => {
      rebound.resolve();
    },
    driver: {
      async status(instance) {
        expect(instance.homeDir).toBe(join(canonicalRoot, "private-account"));
        return loggedIn
          ? { status: "logged-in", source: "sdk-store" }
          : { status: "logged-out", source: "none" };
      },
      async login(instance, _signal, url) {
        expect(instance.homeDir).toBe(join(canonicalRoot, "private-account"));
        url("https://cursor.com/login?challenge=synthetic-cli");
        browser.resolve();
        await finish.promise;
        loggedIn = true;
        return { status: "logged-in", source: "sdk-store" };
      },
      async logout() {
        return { status: "logged-out", source: "none" };
      },
    },
  });
  try {
    await runAccountsCommand(
      ["accounts", "add", "cursor", "fresh", join(alias, "private-account"), "Fresh"],
      {
        env: { ACE_ACCOUNTS_DB: path },
        now: () => 1,
        sdkDiscovery: async () => ({
          installed: true,
          supported: true,
          version: "1.0.35",
          module: "/synthetic-sdk",
        }),
        write: (text) => {
          output.push(text);
          if (text.includes("synthetic-cli")) finish.resolve();
        },
        cursorAuth: async () => ({
          request: (request) =>
            auth.handle("cli-device", { ...request, requestId: `request-${++id}` }),
          async wait() {
            await browser.promise;
            if (loggedIn) await rebound.promise;
          },
          async close() {
            closed = true;
          },
        }),
      },
    );
    expect(loggedIn).toBe(true);
    expect(output).toEqual([
      "Cursor SDK sign-in: https://cursor.com/login?challenge=synthetic-cli\n",
    ]);
    expect(closed).toBe(true);
    expect(registry.get("fresh")?.instance.homeDir).toBe(join(canonicalRoot, "private-account"));
    expect((await readFile(path)).includes(Buffer.from("synthetic-cli"))).toBe(false);
  } finally {
    await auth.close();
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});
