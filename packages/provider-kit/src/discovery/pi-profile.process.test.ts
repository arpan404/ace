import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { discoverPiStatus } from "./pi-status.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// A fake `pi.cmd`, as npm installs Pi on Windows: ready only for the provider the person's
// settings name, so a signed-in answer proves which settings file ace read.
async function windowsPi(root: string) {
  const script = join(root, "pi.js");
  await writeFile(
    script,
    `const args = process.argv.slice(2);
if (args[0] === '--version') console.log('1.2.0');
else if (args[0] === 'auth' && args[1] === 'check') {
  const ready = args[args.indexOf('--provider') + 1] === 'profile-provider';
  console.log(JSON.stringify(ready ? { status: 'ready', authType: 'api_key' } : { status: 'not_ready', reason: 'credentials_not_configured' }));
  process.exitCode = ready ? 0 : 1;
} else process.exitCode = 2;
`,
  );
  const executable = join(root, "pi.cmd");
  await writeFile(executable, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  return executable;
}

test.runIf(process.platform === "win32")(
  "Windows: Pi's settings are read from the profile folder Pi itself uses, not a Git Bash HOME",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-pi-profile-"));
    roots.push(root);
    const profile = join(root, "Users", "person");
    const bashHome = join(root, "msys", "home", "person");
    await mkdir(join(profile, ".pi", "agent"), { recursive: true });
    await mkdir(join(bashHome, ".pi", "agent"), { recursive: true });
    await writeFile(
      join(profile, ".pi", "agent", "settings.json"),
      JSON.stringify({ defaultProvider: "profile-provider" }),
    );
    await writeFile(
      join(bashHome, ".pi", "agent", "settings.json"),
      JSON.stringify({ defaultProvider: "bash-provider" }),
    );
    const executable = await windowsPi(root);
    const env = {
      ...process.env,
      USERPROFILE: profile,
      HOME: bashHome,
      PI_CODING_AGENT_DIR: undefined,
    };
    expect(await discoverPiStatus({ executable, env })).toMatchObject({
      installed: true,
      auth: "logged_in",
    });
  },
);
