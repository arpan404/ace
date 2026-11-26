import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import { GitCli } from "./cli.ts";
import { GitService, type RetiredLease } from "./index.ts";
import { heldLeaseIds } from "./lease-journal.ts";
import { git, proxyGit, repository, scratch } from "./test-repo.ts";

/** These cases are about the native lease core: with the switch off there is no core to serve them. */
const native = (process.env.ACE_GIT ?? "")
  .split(",")
  .map((part) => part.trim())
  .includes("core");

/** A local port nothing listens on: the endpoint of a daemon that has stopped. */
async function stoppedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

/** The durable intent a stopped daemon left for `root`. */
async function leftLease(root: string): Promise<string> {
  const journal = join(await realpath(join(root, ".git")), "ace-mutation-leases");
  await mkdir(journal, { recursive: true });
  const id = randomUUID();
  const file = join(journal, id);
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      id,
      root,
      roots: [root],
      owner: { port: await stoppedPort(), token: randomUUID() },
    }),
  );
  return file;
}

/** A repository at a plain path, with one commit, so Git can snapshot it. */
async function plainRepository(): Promise<string> {
  const repo = await scratch();
  await git(repo, "init", "--initial-branch=main");
  await git(repo, "config", "user.name", "Fixture");
  await git(repo, "config", "user.email", "fixture@example.invalid");
  await git(repo, "commit", "--allow-empty", "-m", "Initial");
  return realpath(repo);
}

describe.runIf(native)("lease operations use the calling service's own core", () => {
  test("each service's heal reports a retirement to its own callback", async () => {
    const repo = await realpath(await repository());
    await leftLease(repo);
    const first: RetiredLease[] = [];
    const second: RetiredLease[] = [];
    const one = new GitService({ onLeaseRetired: (event) => first.push(event), leaseWaitMs: 0 });
    const second_service = new GitService({
      onLeaseRetired: (event) => second.push(event),
      leaseWaitMs: 0,
    });
    try {
      await one.heal(repo);
      expect(first).toMatchObject([{ reason: "owner_gone_processes_gone" }]);
      expect(second).toEqual([]);
    } finally {
      await one.close();
      await second_service.close();
    }
  });

  test("a native retirement is reported once and leaves no lease of this process behind", async () => {
    const repo = await plainRepository();
    // write-tree hangs until ace's deadline kills its whole process group.
    const binary = await proxyGit(
      `if (args.includes('write-tree')) { setInterval(()=>{},1000); return; }`,
    );
    const retired: RetiredLease[] = [];
    const stuck = new GitService({
      gitBinary: binary,
      timeoutMs: 1000,
      onLeaseRetired: (event) => retired.push(event),
    });
    try {
      await expect(
        stuck.createCheckpoint({ worktree: repo, threadId: "send", label: "stuck" }),
      ).rejects.toMatchObject({ code: "git_timeout" });
      await stuck.heal(repo);
      expect(retired).toMatchObject([{ reason: "own_processes_gone" }]);
      expect(heldLeaseIds()).toEqual([]);
      // Nothing is left to retire: a second sweep reports nothing again.
      await stuck.heal(repo);
      expect(retired).toHaveLength(1);
    } finally {
      await stuck.close();
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("a failing streamed call ends the caller's output", async () => {
    const repo = await plainRepository();
    const cli = new GitCli({});
    const chunks: string[] = [];
    let finished = false;
    const output = new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk.toString());
        done();
      },
    });
    output.on("finish", () => {
      finished = true;
    });
    try {
      // A payload failure (`git_failed` with Git's stderr), not a transport error.
      await expect(
        cli.call(repo, ["rev-parse", "--verify", "no-such-ref"], { output }),
      ).rejects.toMatchObject({ code: "git_failed" });
      await expect.poll(() => finished, { timeout: 2_000 }).toBe(true);
    } finally {
      await cli.close();
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("the op log shows each lease operation completing natively", async () => {
    const repo = await plainRepository();
    const log = join(await scratch(), "ops.log");
    process.env.ACE_GIT_OP_LOG = log;
    const service = new GitService({ leaseWaitMs: 0 });
    try {
      await service.mutationState(repo);
      await service.assertMutationAvailable(repo);
      await service.clearStaleLeases(repo);
      await service.heal(repo);
      await service.healAll([repo], () => {});
      await service.recoverCleanup(repo);
      const records = (await readFile(log, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { op: string; completed: string });
      for (const op of [
        "mutationState",
        "assertMutationAvailable",
        "clearStaleLeases",
        "heal",
        "healAll",
        "recoverCleanup",
      ]) {
        expect(
          records.some((record) => record.op === op && record.completed === "native"),
          `${op} completed natively`,
        ).toBe(true);
      }
    } finally {
      delete process.env.ACE_GIT_OP_LOG;
      await service.close();
      await rm(repo, { recursive: true, force: true });
    }
  });
});
