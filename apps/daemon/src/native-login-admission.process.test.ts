import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { nativeLoginHarness } from "./native-login-test-support.ts";

const cases = ["API key", "upstream choice"].flatMap((phase) =>
  ["binary path", "disabled", "login revision", "selected account"].map((change) => ({
    phase,
    change,
  })),
);

test.each(cases)(
  "a $change change during $phase prevents deferred launches and secret hand-off",
  async ({ phase, change }) => {
    const f = await nativeLoginHarness(phase === "API key" ? "codex" : "opencode");
    try {
      const home = join(f.instance.homeDir, "user");
      const session = await f.start(phase === "upstream choice" ? "login" : "api_key");
      await f.wait(phase === "upstream choice" ? "awaiting_input" : "awaiting_api_key");
      const request = {
        type: "provider.login.apiKey",
        requestId: "key",
        session,
        apiKey: "opaque-synthetic-key-never-a-real-credential",
      };
      if (change === "selected account")
        f.f.registry.selectProvider(
          f.instance.provider,
          (await f.f.add(f.instance.provider === "opencode" ? "opencode" : "codex")).id,
        );
      else if (change === "login revision") f.f.registry.loginChanged(f.instance.id);
      else
        await f.configure(
          change === "binary path" ? { binaryPath: f.replacement } : { enabled: false },
        );
      if (phase === "upstream choice")
        await f.sessions.handle("owner", {
          type: "provider.login.input",
          requestId: "choice",
          session,
          input: { choice: "github-copilot" },
        });
      else await f.sessions.handle("owner", request);
      expect((await f.sessions.completed("owner", session)).state).toBe("failed");
      await expect(readFile(join(home, "cli-credential"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(join(home, "login-started"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.stringify(f.events)).not.toContain("opaque-synthetic-key");
      expect(f.f.registry.summary(f.instance.id, 100)?.quota.auth).toBe("logged_out");
      expect(f.f.accounts.isChangingAccount(f.instance.id)).toBe(false);
    } finally {
      await f.close();
    }
  },
);

test("an unchanged native API-key login hands the key to its configured executable and completes", async () => {
  const f = await nativeLoginHarness("codex");
  try {
    const session = await f.start("api_key");
    await f.wait("awaiting_api_key");
    await f.sessions.handle("owner", {
      type: "provider.login.apiKey",
      requestId: "key",
      session,
      apiKey: "opaque-synthetic-control",
    });
    expect((await f.sessions.completed("owner", session)).state).toBe("succeeded");
    expect(await readFile(join(f.instance.homeDir, "user", "cli-credential"), "utf8")).toBe(
      "opaque-synthetic-control",
    );
    expect(f.f.registry.summary(f.instance.id, 100)?.quota.auth).toBe("logged_in");
  } finally {
    await f.close();
  }
});
