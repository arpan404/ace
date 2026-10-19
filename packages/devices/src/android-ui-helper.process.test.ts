import { expect, it, onTestFinished } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeBinary } from "@ace/provider-kit/testing";
import { DevicePlatform } from "./index.ts";

const tree = (label: string) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="${label}" class="android.widget.Button" clickable="true" enabled="true" bounds="[0,0][10,10]" /></hierarchy>`;

/**
 * adb is a stand-in whose `shell -T ... dev.ace.uihelper.Main` plays the on-device helper: it
 * announces READY and answers each `tree` line, as the real dex does over adb's stdio.
 */
async function fixture(mode: "ok" | "err") {
  const root = await mkdtemp(join(tmpdir(), "ace-ui-helper-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const journal = join(root, "journal");
  await writeFile(journal, "");
  await mkdir(join(root, "sdk/platform-tools"), { recursive: true });
  await mkdir(join(root, "sdk/emulator"), { recursive: true });
  await nodeBinary(
    join(root, "sdk/platform-tools"),
    "adb",
    `const fs = require("node:fs");
const log = (line) => fs.appendFileSync(process.env.JOURNAL, line + "\\n");
const command = process.argv.slice(2).join(" ");
if (!command.includes("dev.ace.uihelper.Main")) process.exit(3);
log("start");
let answered = 0;
process.stdout.write("READY\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  if (line !== "tree") return;
  answered++;
  process.stdout.write(process.env.MODE === "ok"
    ? "OK " + ${JSON.stringify(tree("Helper"))}.replace("Helper", "Helper " + answered) + "\\n"
    : "ERR java.lang.IllegalStateException: null root node\\n");
}).on("close", () => { log("exit"); process.exit(0); });`,
  );
  await nodeBinary(join(root, "sdk/emulator"), "emulator", "");
  const timers: { ms: number; run(): void; live: boolean }[] = [];
  const commands: string[] = [];
  const platform = new DevicePlatform({
    platform: "linux",
    home: root,
    env: { PATH: "/usr/bin:/bin", ANDROID_HOME: join(root, "sdk"), JOURNAL: journal, MODE: mode },
    toolsDirectory: join(root, "tools"),
    after(ms, run) {
      const timer = { ms, run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    async probe(_command, args) {
      const line = args.join(" ");
      commands.push(line);
      const stdout = line.includes("-list-avds")
        ? "Pixel"
        : line === "devices -l"
          ? "List of devices attached\nemulator-5554 device"
          : line.includes("avd_name")
            ? "Pixel"
            : args.includes("cat")
              ? tree("Dumped")
              : "";
      return { stdout, stderr: "", code: 0 };
    },
  });
  onTestFinished(() => platform.close());
  const [android] = (await platform.list()).filter((device) => device.platform === "android");
  if (!android) throw new Error("No emulator");
  return {
    platform,
    android,
    commands,
    journal: async () => (await readFile(journal, "utf8")).split("\n").filter(Boolean),
    fireIdle() {
      for (const timer of timers.filter((entry) => entry.live && entry.ms === 30_000)) {
        timer.live = false;
        timer.run();
      }
    },
  };
}
const label = (result: { nodes: { name: string }[] }) => result.nodes[0]?.name;
async function until(read: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not reached");
}

it("UI trees come from one long-running helper instead of a uiautomator dump per read", async () => {
  const f = await fixture("ok");
  expect(label(await f.platform.uiTree(f.android, {}))).toBe("Helper 1");
  expect(label(await f.platform.uiTree(f.android, {}))).toBe("Helper 2");
  expect(await f.journal()).toEqual(["start"]);
  expect(f.commands.some((line) => line.includes("'uiautomator' 'dump'"))).toBe(false);
  expect(f.commands.filter((line) => line.includes("push"))).toHaveLength(1);
});

it("an idle helper exits, so UiAutomation is free for test runners, and the next read restarts it", async () => {
  const f = await fixture("ok");
  await f.platform.uiTree(f.android, {});
  f.fireIdle();
  await until(async () => (await f.journal()).includes("exit"));
  expect(label(await f.platform.uiTree(f.android, {}))).toBe("Helper 1");
  expect(await f.journal()).toEqual(["start", "exit", "start"]);
});

it("when the helper cannot read the screen, the tree still comes from uiautomator's dump", async () => {
  const f = await fixture("err");
  expect(label(await f.platform.uiTree(f.android, {}))).toBe("Dumped");
  // The failed helper let go of UiAutomation before uiautomator needed it.
  await until(async () => (await f.journal()).includes("exit"));
  expect(f.commands.some((line) => line.includes("'uiautomator' 'dump'"))).toBe(true);
});
