import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { cursorSandboxChecks, type CursorSandboxMachine } from "./cursor-sandbox-check.ts";

const home = "/home/me";
const releaseHelper =
  "/home/me/.ace/releases/1.2.0-linux-arm64/node_modules/@cursor/sdk-linux-arm64/bin/cursorsandbox";

function machine(overrides: Partial<CursorSandboxMachine>): CursorSandboxMachine {
  return {
    restricted: () => true,
    helper: async () => releaseHelper,
    preflight: async () => ({ code: 2, stderr: "Failed to resolve Linux sandbox backend" }),
    glibc: () => "2.43",
    ...overrides,
  };
}

async function verdict(overrides: Partial<CursorSandboxMachine>) {
  const [check] = cursorSandboxChecks({
    dataDir: "/home/me/.ace",
    home,
    machine: machine(overrides),
  });
  if (!check) throw new Error("no check");
  return check.run(AbortSignal.timeout(5_000));
}

/** The profile between the heredoc markers of the fix's commands. */
function profileIn(fix: string): string {
  const text = /<<'EOF'\n([\s\S]*?)\nEOF/.exec(fix)?.[1];
  if (!text) throw new Error(`no profile in ${fix}`);
  return `${text}\n`;
}

test("doctor stays quiet about Cursor's sandbox where user namespaces aren't restricted", () => {
  expect(
    cursorSandboxChecks({
      dataDir: "/home/me/.ace",
      home,
      machine: machine({ restricted: () => false }),
    }),
  ).toEqual([]);
});

test("a helper AppArmor blocks gets a one-time profile covering every standalone release", async () => {
  const result = await verdict({});
  expect(result.status).toBe("warn");
  expect(result.message).toMatch(/Cursor can't run in Auto review: AppArmor restricts/);
  expect(result.fix).toContain("sudo tee /etc/apparmor.d/ace-cursor-sandbox >/dev/null <<'EOF'");
  expect(result.fix).toContain("sudo apparmor_parser -r /etc/apparmor.d/ace-cursor-sandbox");
  expect(profileIn(result.fix)).toContain(
    "profile ace-cursor-sandbox @{HOME}/.ace/releases/*/node_modules/@cursor/sdk-linux-{x64,arm64}/bin/cursorsandbox flags=(unconfined) {",
  );
});

test("a helper outside a standalone release is attached by its own path", async () => {
  const helper = "/srv/ace dev/node_modules/@cursor/sdk-linux-x64/bin/cursorsandbox";
  const result = await verdict({ helper: async () => helper });
  expect(profileIn(result.fix)).toContain(`profile ace-cursor-sandbox "${helper}" flags=`);
});

test("a helper whose preflight passes reports Cursor's sandbox working", async () => {
  const result = await verdict({ preflight: async () => ({ code: 0, stderr: "" }) });
  expect(result.status).toBe("ok");
});

test("an old glibc is reported as such, not as an AppArmor profile to install", async () => {
  const stderr =
    "/x/cursorsandbox: /lib/aarch64-linux-gnu/libc.so.6: version `GLIBC_2.39' not found (required by /x/cursorsandbox)";
  const result = await verdict({
    preflight: async () => ({ code: 1, stderr }),
    glibc: () => "2.35",
  });
  expect(result.message).toMatch(/needs glibc 2\.39 and this system has 2\.35/);
  expect(result.fix).not.toContain("apparmor");
});

const parser = spawnSync("apparmor_parser", ["--version"]).status === 0;
test.skipIf(!parser)("AppArmor accepts the profile doctor prints for Cursor's helper", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ace-cursor-profile-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "ace-cursor-sandbox");
  await writeFile(file, profileIn((await verdict({})).fix));
  const run = spawnSync("apparmor_parser", ["-QK", "-d", file], { encoding: "utf8" });
  expect(run.status, run.stderr).toBe(0);
  expect(`${run.stdout}\n${run.stderr}`).toMatch(/Mode:\s+unconfined/);
});
