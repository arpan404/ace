import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { ComputerClient, ScreenManager } from "@ace/screen";

const packages = new URL("../../../../packages/screen/src/", import.meta.url);
/** The scripted computer-use engine (`ace-screen-helper --computer`): Calculator and friends. */
const engine = new URL("computer/testing/fake-computer-helper.ts", packages).pathname;
/** The live-view helper; only its computer-use switch is used here. */
const viewer = new URL("testing/fake-helper-v2.ts", packages).pathname;

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
}, 30_000);

function exited(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
  });
}

/**
 * One machine's computer use, as a daemon runs it: the person's switch and real computer-use
 * engine processes (the scripted fake helper). Closed after the test.
 */
export async function computerUse() {
  const home = await mkdtemp(join(tmpdir(), "ace-machine-screen-"));
  const screen = new ScreenManager({
    command: process.execPath,
    args: [viewer],
    platform: "darwin",
    endpoint: `unix:${join(home, "pipe")}`,
    nextId: () => "unused",
    recordingDirectory: home,
    publishArtifact: async () => {},
  });
  const children: ChildProcessWithoutNullStreams[] = [];
  let next = 0;
  const computer = new ComputerClient({
    helper: async () => "fake-helper",
    nextId: () => `r${++next}`,
    spawnHelper: (_command, args, env) => {
      const child = spawn(process.execPath, [engine, ...args], {
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.push(child);
      return child;
    },
  });
  cleanup.push(async () => {
    computer.close();
    await Promise.all(children.map(exited));
    await screen.close();
    await rm(home, { recursive: true, force: true });
  });
  return { screen, computer };
}
