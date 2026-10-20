import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, onTestFinished } from "vitest";
import { nodeBinary } from "@ace/provider-kit/testing";
import { DevicePlatform, type Device } from "./index.ts";

const udid = "22222222-2222-4222-8222-222222222222";
const ios: Device = { id: `ios:${udid}`, platform: "ios", name: "iPhone", state: "booted" };

/** A Mac whose `xcrun simctl pbcopy|pbpaste` keep the pasteboard in a file. */
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "ace-sim-clipboard-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const pasteboard = join(home, "pasteboard");
  const calls = join(home, "calls");
  await writeFile(pasteboard, "");
  await writeFile(calls, "");
  await nodeBinary(
    home,
    "xcode-select",
    "console.log('/Applications/Xcode.app/Contents/Developer');",
  );
  await nodeBinary(home, "open", "");
  await nodeBinary(
    home,
    "xcrun",
    `const fs = require('node:fs');
    const args = process.argv.slice(2);
    fs.appendFileSync(process.env.CALLS, args.join(' ') + '\\n');
    if (process.env.FAIL === '1') process.exit(3);
    if (args[1] === 'pbcopy') {
      const chunks = [];
      process.stdin.on('data', (chunk) => chunks.push(chunk));
      // Like simctl, stdin is decoded by the locale: without UTF-8 it is mangled as 8-bit text.
      const utf8 = /UTF-8/i.test(process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '');
      process.stdin.on('end', () => {
        const bytes = Buffer.concat(chunks);
        fs.writeFileSync(process.env.PASTEBOARD, utf8 ? bytes : Buffer.from(bytes.toString('latin1'), 'utf8'));
      });
    } else if (args[1] === 'pbpaste') process.stdout.write(fs.readFileSync(process.env.PASTEBOARD));`,
  );
  const env: NodeJS.ProcessEnv = { PATH: home, PASTEBOARD: pasteboard, CALLS: calls };
  const platform = new DevicePlatform({ platform: "darwin", home, env });
  onTestFinished(() => platform.close());
  return { platform, env, pasteboard, calls: async () => readFile(calls, "utf8") };
}

// The fixture's environment has no locale, as a daemon started by launchd has none.
it("the Simulator pasteboard is set and read exactly: Unicode, trailing newline and all", async () => {
  const f = await fixture();
  await f.platform.clipboardWrite(ios, "first line\nsecond 👋\n");
  expect(await readFile(f.pasteboard, "utf8")).toBe("first line\nsecond 👋\n");
  expect(await f.platform.clipboardRead(ios)).toEqual({
    text: "first line\nsecond 👋\n",
    truncated: false,
  });
  expect(await f.calls()).toBe(`simctl pbcopy ${udid}\nsimctl pbpaste ${udid}\n`);
});

it("a pasteboard larger than the budget is cut on a character boundary and marked", async () => {
  const f = await fixture();
  await writeFile(f.pasteboard, "👋".repeat(40_000));
  const read = await f.platform.clipboardRead(ios);
  expect(read.truncated).toBe(true);
  expect(read.text).toBe("👋".repeat(2048));
});

it("a failing simctl reports command_failed, and authority is checked before it runs", async () => {
  const f = await fixture();
  f.env["FAIL"] = "1";
  await expect(f.platform.clipboardRead(ios)).rejects.toMatchObject({ code: "command_failed" });
  delete f.env["FAIL"];
  await expect(
    f.platform.clipboardWrite(ios, "secret", () => {
      throw new Error("control moved");
    }),
  ).rejects.toThrow("control moved");
  expect(await readFile(f.pasteboard, "utf8")).toBe("");
});

it("an Android emulator without ace's live view refuses the clipboard with a fix", async () => {
  const f = await fixture();
  const android: Device = {
    id: "android:Pixel",
    platform: "android",
    name: "Pixel",
    state: "booted",
  };
  await expect(f.platform.clipboardRead(android)).rejects.toMatchObject({
    code: "not_supported",
    hint: expect.stringContaining("sim_start"),
  });
});
