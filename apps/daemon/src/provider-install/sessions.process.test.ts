import { expect, test } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { probeOutput } from "@ace/provider-kit/process";
import { installFixture } from "./testing.ts";

test("official npm install, update and uninstall stream bounded sanitized progress and refresh discovery", async () => {
  const f = await installFixture({ managers: ["npm"] });
  f.env.NPM_TOKEN = "a-private-package-manager-token";
  try {
    const readiness: unknown[] = [];
    f.statuses.listen((rows) => readiness.push(rows));
    for (const action of ["install", "update", "uninstall"] as const) {
      const started = await f.request({
        type: "provider.install.run",
        requestId: action,
        provider: "codex",
        action,
        method: "npm",
      });
      if (!started.result.ok || !("progress" in started.result))
        throw new Error("Expected session");
      const session = started.result.progress.session;
      const end = await f.wait(
        (event) => event.session === session && ["succeeded", "failed"].includes(event.state),
      );
      expect(end.state).toBe("succeeded");
      expect(end.lines.length).toBeLessThanOrEqual(100);
      expect(JSON.stringify(end)).not.toContain("a-private-package-manager-token");
      expect(JSON.stringify(end)).not.toContain("\u001b");
      expect(f.statuses.readiness().find((row) => row.provider === "codex")).toMatchObject({
        installed: action !== "uninstall",
        ...(action !== "uninstall" ? { version: "2.0.0" } : {}),
      });
    }
    expect(readiness).toHaveLength(3);
    const commands = (await f.calls()).filter((call) =>
      ["install", "uninstall"].includes(call[1] ?? ""),
    );
    expect(commands).toEqual([
      ["npm", "install", "-g", "@openai/codex@latest"],
      ["npm", "install", "-g", "@openai/codex@latest"],
      ["npm", "uninstall", "-g", "@openai/codex"],
    ]);
    expect(f.logs).toContain("codex: 2.0.0");
    expect(f.logs).toContain(`${join(f.bin, "npm")} install -g @openai/codex@latest`);
    expect(f.events.some((event) => event.state === "verifying")).toBe(true);
  } finally {
    await f.close();
  }
});

test("cancellation stops the package manager and its stubborn child before another provider operation is admitted", async () => {
  const f = await installFixture({ managers: ["npm"] });
  try {
    await writeFile(join(f.home, "mode"), "hang");
    const result = await f.request({
      type: "provider.install.run",
      requestId: "run",
      provider: "codex",
      action: "install",
      method: "npm",
    });
    if (!result.result.ok || !("progress" in result.result)) throw new Error("Expected session");
    const session = result.result.progress.session;
    const running = await f.wait((event) => event.lines.some((line) => line.startsWith("child=")));
    const child = running.lines.find((line) => line.startsWith("child="))?.slice(6);
    expect(child).toMatch(/^\d+$/);
    expect(
      await f.request({
        type: "provider.install.run",
        requestId: "other",
        provider: "codex",
        action: "install",
        method: "npm",
      }),
    ).toMatchObject({ result: { ok: false, error: "busy" } });
    expect(
      await f.request(
        { type: "provider.install.cancel", requestId: "cancel", session },
        "other-device",
      ),
    ).toMatchObject({ result: { ok: false, error: "forbidden" } });
    expect(
      await f.request({ type: "provider.install.cancel", requestId: "cancel", session }),
    ).toMatchObject({ result: { ok: true, progress: { state: "cancelled" } } });
    const state = await probeOutput("/bin/ps", ["-o", "stat=", "-p", child ?? "0"], { env: f.env });
    expect(state.stdout === "" || state.stdout.startsWith("Z")).toBe(true);
    await writeFile(join(f.home, "mode"), "");
    const next = await f.request({
      type: "provider.install.run",
      requestId: "next",
      provider: "codex",
      action: "install",
      method: "npm",
    });
    expect(next.result.ok).toBe(true);
    await f.wait((event) => event.state === "succeeded");
  } finally {
    await f.close();
  }
});

test("admin-required plans and method switches never launch a mutation or sudo", async () => {
  const f = await installFixture({ writable: false });
  try {
    const plan = await f.installs.plan({ provider: "codex" }, "install");
    expect(plan).toMatchObject({ needsAdmin: true, status: "ready", method: "npm" });
    await f.request({
      type: "provider.install.run",
      requestId: "admin",
      provider: "codex",
      action: "install",
      method: "npm",
    });
    const end = await f.wait((event) => event.state === "needs_admin");
    expect(end.plan?.commands[0]?.args).toEqual(["install", "-g", "@openai/codex@latest"]);
    expect((await f.calls()).some((call) => call[1] === "install" || call[0] === "sudo")).toBe(
      false,
    );
    await f.existing("codex", "brew");
    await f.request({
      type: "provider.install.run",
      requestId: "switch",
      provider: "codex",
      action: "update",
      method: "npm",
    });
    expect(await f.wait((event) => event.state === "failed")).toMatchObject({
      plan: { status: "unavailable" },
    });
    expect((await f.calls()).some((call) => call[1] === "install")).toBe(false);
  } finally {
    await f.close();
  }
});

test("installer failure retains its exit and sanitized error without declaring success", async () => {
  const f = await installFixture({ managers: ["npm"] });
  try {
    await writeFile(join(f.home, "mode"), "fail");
    await f.request({
      type: "provider.install.run",
      requestId: "fail",
      provider: "codex",
      action: "install",
      method: "npm",
    });
    const end = await f.wait((event) => event.state === "failed");
    expect(end.exit).toBe(7);
    expect(JSON.stringify(end)).not.toContain("not-for-clients");
    expect(f.statuses.list().find((row) => row.provider === "codex")?.installed).not.toBe(true);
  } finally {
    await f.close();
  }
});

test("a zero-exit installer with an unusable binary fails verification", async () => {
  const f = await installFixture({ managers: ["npm"] });
  try {
    await writeFile(join(f.home, "mode"), "invalid");
    await f.request({
      type: "provider.install.run",
      requestId: "invalid",
      provider: "codex",
      action: "install",
      method: "npm",
    });
    expect(await f.wait((event) => event.state === "failed")).toMatchObject({
      exit: 0,
      message: "The installed binary did not pass --version verification.",
    });
    expect(f.events.some((event) => event.state === "succeeded")).toBe(false);
  } finally {
    await f.close();
  }
});
