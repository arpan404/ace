import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, onTestFinished } from "vitest";
import { spawnSupervised } from "@ace/provider-kit/process";
import { AndroidInputShell } from "./android-input-shell.ts";
import { androidInput } from "./commands.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ace-input-shell-"));
  const bin = join(root, "adb");
  const journal = join(root, "starts");
  const output = join(root, "input");
  await mkdir(join(root, "bin"));
  await writeFile(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$DEVICE_STARTS"\nexec /bin/sh\n`, {
    mode: 0o755,
  });
  await writeFile(join(root, "bin/input"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$DEVICE_INPUT"\n`, {
    mode: 0o755,
  });
  const shell = new AndroidInputShell({
    adb: bin,
    serial: "emulator-5554",
    env: {
      PATH: join(root, "bin") + ":/usr/bin:/bin",
      DEVICE_STARTS: journal,
      DEVICE_INPUT: output,
    },
    spawn: spawnSupervised,
    after: (ms, run) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
  });
  onTestFinished(async () => {
    await shell.close();
    await rm(root, { recursive: true, force: true });
  });
  const send = async (input: Parameters<typeof androidInput>[0], authorize = () => {}) => {
    const command = androidInput(input)[1];
    if (!command) throw new Error("Missing input command");
    await shell.send(command, authorize);
  };
  return { root, shell, send, journal, output };
}
it("Android taps and typing reuse one pinned shell and preserve literal text without shell execution", async () => {
  const f = await fixture();
  for (let i = 0; i < 10; i++) await f.send({ kind: "tap", x: i, y: 20 });
  await f.send({ kind: "type", text: "a'; touch pwned; $(pwd)" });
  expect((await readFile(f.output, "utf8")).trim().split("\n")).toEqual([
    ...Array.from({ length: 10 }, (_, i) => `tap ${i} 20`),
    "text a';%stouch%spwned;%s$(pwd)",
  ]);
  expect((await readFile(f.journal, "utf8")).trim()).toBe("-s emulator-5554 shell -T");
  await expect(readFile(join(f.root, "pwned"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("a revoked queued Android input never reaches the device and a closed transport never replays it", async () => {
  const f = await fixture();
  const first = f.send({ kind: "tap", x: 1, y: 2 });
  const refused = f.send({ kind: "tap", x: 3, y: 4 }, () => {
    throw new Error("Lease expired");
  });
  const rejection = expect(refused).rejects.toThrow("Lease expired");
  await first;
  await rejection;
  await f.shell.close();
  await expect(f.send({ kind: "tap", x: 5, y: 6 })).rejects.toMatchObject({
    code: "command_failed",
  });
  expect((await readFile(f.output, "utf8")).trim()).toBe("tap 1 2");
});
