import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { expect, test } from "vitest";
import { testHomeEnvironment } from "../../../scripts/test-home-environment.ts";

const Reply = z.object({ id: z.number().optional(), error: z.string().optional() });

test("idle performance seeding finds its assistant message after additive projection events", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-idle-seed-"));
  const child = fork(new URL("../bench/entry.ts", import.meta.url), [], {
    execArgv: [],
    env: {
      ...testHomeEnvironment(home, process.env.ACE_TEST_REAL_HOME ?? "/private/user-home"),
      PATH: "",
      ACE_HOME: home,
      ACE_WORKSPACE_ROOT: home,
      ACE_PORT: "0",
      ACE_LISTEN: "local",
      ACE_LOG_LEVEL: "silent",
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const exited = once(child, "exit");
  const receive = async () => {
    const [raw] = await Promise.race([
      once(child, "message"),
      exited.then(() => {
        throw new Error("Seed process exited before replying");
      }),
    ]);
    return Reply.parse(raw);
  };
  try {
    expect((await receive()).id).toBe(0);
    const seeded = receive();
    child.send({ id: 1, op: "idle-store" });
    const result = await seeded;
    expect(result.error).toBeUndefined();
    expect(result.id).toBe(1);
    child.send({ id: 2, op: "close" });
    expect(await exited).toEqual([0, null]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await rm(home, { recursive: true, force: true });
  }
});
