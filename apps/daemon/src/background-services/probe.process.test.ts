import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { systemPortProbe } from "./probe.ts";

/*
 * The real OS edge of the port probe (ADR 0109): lsof on macOS, /proc on Linux. The pure
 * attribution is covered in port-watcher.test.ts; this proves the tables are read and joined.
 */

const children: ChildProcess[] = [];
let dir: string | undefined;

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const server = `require("node:net").createServer().listen(0, "127.0.0.1", function () {
  console.log("port " + this.address().port);
});`;

/** A shell started the way a provider starts a background command: output to a file. */
function backgroundServer(output: string): ChildProcess {
  const child = spawn(
    "/bin/sh",
    ["-c", `"${process.execPath}" -e '${server}' > "${output}" 2>&1`],
    {
      stdio: "ignore",
    },
  );
  children.push(child);
  return child;
}

async function printedPort(output: string): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const port = /port (\d+)/.exec(await readFile(output, "utf8").catch(() => ""))?.[1];
    if (port) return Number(port);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("server never printed its port");
}

it.runIf(process.platform === "darwin" || process.platform === "linux")(
  "finds the port a background server listens on through its output file, and only its own",
  async () => {
    dir = await mkdtemp(join(tmpdir(), "ace-ports-"));
    const dev = join(dir, "dev.output");
    const other = join(dir, "other.output");
    backgroundServer(dev);
    const otherServer = backgroundServer(other);
    const port = await printedPort(dev);
    await printedPort(other);
    const probe = systemPortProbe();
    expect((await probe([dev])).get(dev)).toEqual([port]);
    otherServer.kill("SIGKILL");
    const quiet = join(dir, "quiet.output");
    expect((await probe([quiet])).get(quiet)).toEqual([]);
  },
  20_000,
);
