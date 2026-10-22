import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { nativeLoginHarness } from "./native-login-test-support.ts";

test.each(["login", "logout"] as const)(
  "OpenCode v2 %s verifies the chosen integration in its managed account while preserving another service",
  async (action) => {
    const f = await nativeLoginHarness("opencode", async () => []);
    const home = f.credentialHome;
    try {
      await writeFile(join(home, "other-credential"), "another configured service");
      if (action === "logout") await writeFile(join(home, "cli-credential"), "previous login");
      const started = await f.sessions.handle(
        "owner",
        action === "login"
          ? {
              type: "provider.login.start",
              requestId: "start",
              provider: "opencode",
              instance: f.instance.id,
            }
          : {
              type: "provider.logout",
              requestId: "start",
              provider: "opencode",
              instance: f.instance.id,
            },
      );
      if (!started.result.ok) throw new Error("Login not admitted");
      const session = started.result.progress.session;
      await f.wait("awaiting_input");
      await f.sessions.handle("owner", {
        type: "provider.login.input",
        requestId: "choice",
        session,
        input: { choice: "github-copilot" },
      });
      const progress = await f.sessions.handle("owner", {
        type: "provider.login.poll",
        requestId: "poll",
        session,
      });
      const terminalId = progress.result.ok && progress.result.progress.manual?.terminalId;
      if (!terminalId) throw new Error("Embedded sign-in terminal missing");
      const ready = Promise.withResolvers<void>();
      await f.f.management.subscribe(terminalId, "owner", (event) => {
        if (event.type === "data" && event.data.includes("Press Enter")) ready.resolve();
      });
      await ready.promise;
      f.f.management.write(terminalId, "owner", "\r");
      expect((await f.sessions.completed("owner", session)).state).toBe("succeeded");
      expect(await readFile(join(home, "other-credential"), "utf8")).toBe(
        "another configured service",
      );
      if (action === "login")
        expect(await readFile(join(home, "cli-credential"), "utf8")).toBe("browser login");
      else
        await expect(readFile(join(home, "cli-credential"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      expect(f.f.accounts.isChangingAccount(f.instance.id)).toBe(false);
    } finally {
      await f.close();
    }
  },
);

test("OpenCode v2 logout through the untargeted picker succeeds while another service remains", async () => {
  const f = await nativeLoginHarness("opencode", async () => []);
  const home = f.credentialHome;
  try {
    await writeFile(join(home, "other-credential"), "another configured service");
    await writeFile(join(home, "cli-credential"), "previous login");
    const started = await f.sessions.handle("owner", {
      type: "provider.logout",
      requestId: "start",
      provider: "opencode",
      instance: f.instance.id,
    });
    if (!started.result.ok) throw new Error("Login not admitted");
    const session = started.result.progress.session;
    await f.wait("awaiting_input");
    await f.sessions.handle("owner", {
      type: "provider.login.input",
      requestId: "choice",
      session,
      input: { choice: "other" },
    });
    const progress = await f.sessions.handle("owner", {
      type: "provider.login.poll",
      requestId: "poll",
      session,
    });
    const terminalId = progress.result.ok && progress.result.progress.manual?.terminalId;
    if (!terminalId) throw new Error("Embedded sign-in terminal missing");
    const ready = Promise.withResolvers<void>();
    await f.f.management.subscribe(terminalId, "owner", (event) => {
      if (event.type === "data" && event.data.includes("Press Enter")) ready.resolve();
    });
    await ready.promise;
    f.f.management.write(terminalId, "owner", "\r");
    expect((await f.sessions.completed("owner", session)).state).toBe("succeeded");
    expect(await readFile(join(home, "other-credential"), "utf8")).toBe(
      "another configured service",
    );
    await expect(readFile(join(home, "cli-credential"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(f.f.accounts.isChangingAccount(f.instance.id)).toBe(false);
  } finally {
    await f.close();
  }
});
