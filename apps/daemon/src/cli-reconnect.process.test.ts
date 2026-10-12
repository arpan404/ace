import { join } from "node:path";
import { z } from "zod";
import { expect, test } from "vitest";
import { Command, ThreadId } from "@ace/protocol";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { remoteCliFixture } from "./cli-remote-test-support.ts";
import { openCli, startCli, invoke } from "./cli-test-support.ts";

test(
  "quit detaches promptly when a connection drops before the attached thread snapshot",
  { timeout: 30000 },
  async () => {
    const f = await remoteCliFixture();
    f.interruptBeforeSnapshots();
    const cli = openCli(f.home, [
      "chat",
      "--thread",
      f.caller.threadId,
      ...f.remoteArgs,
      "--stream",
      "jsonl",
    ]);
    try {
      await expect.poll(f.lostSnapshots).toBeGreaterThan(0);
      cli.child.stdin.write("/quit\n");
      let exited = false;
      void cli.exited.then(() => {
        exited = true;
      });
      await expect.poll(() => exited, { timeout: 5000 }).toBe(true);
      const result = await cli.exited;
      expect(result.code, result.stderr).toBe(5);
      const records: unknown[] = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.at(-1)).toMatchObject({
        status: "uncertain",
        admission: { threadId: f.caller.threadId },
      });
      expect(f.commands).toEqual([]);
    } finally {
      cli.child.kill("SIGKILL");
      await cli.exited;
      await f.close();
    }
  },
);

test(
  "a single stdin chunk containing a prompt and quit exits uncertain and keeps the prompt replayable",
  { timeout: 30000 },
  async () => {
    const f = await remoteCliFixture();
    f.loseReplies();
    const cli = startCli(
      f.home,
      [
        "chat",
        "--project",
        f.workspace,
        "--provider",
        "claude",
        "--idempotency-key",
        "buffered-quit",
        ...f.remoteArgs,
        "--stream",
        "jsonl",
      ],
      "Single chunk prompt\n/quit\n",
    );
    try {
      let exited = false;
      void cli.exited.then(() => {
        exited = true;
      });
      await expect.poll(() => exited, { timeout: 5000 }).toBe(true);
      const result = await cli.exited;
      expect(result.code, result.stderr).toBe(5);
      const records = result.stdout
        .trim()
        .split("\n")
        .map((line): unknown => JSON.parse(line));
      const evidence = z
        .object({
          status: z.literal("uncertain"),
          admission: z.object({ threadId: ThreadId, idempotencyKey: z.literal("buffered-quit") }),
        })
        .parse(records.at(-1)).admission;
      const db = new DatabaseSync(join(f.home, "cli-remotes", f.profileId, "cli-outbox.sqlite"));
      try {
        const row = z
          .object({ value: z.string() })
          .parse(db.prepare("SELECT value FROM intents WHERE id=?").get(evidence.idempotencyKey));
        expect(
          z.object({ command: Command }).parse(JSON.parse(row.value)).command.payload,
        ).toMatchObject({ type: "thread.create", threadId: evidence.threadId });
      } finally {
        db.close();
      }
      f.restoreReplies();
      const replay = await invoke(f.home, [
        "run",
        "Single chunk prompt",
        "--project",
        f.workspace,
        "--provider",
        "claude",
        "--idempotency-key",
        evidence.idempotencyKey,
        ...f.remoteArgs,
        "--json",
      ]);
      expect(replay.code, replay.stderr).toBe(0);
      expect(JSON.parse(replay.stdout)).toMatchObject({ threadId: evidence.threadId });
      await f.daemon.engine?.flush();
      expect(f.h.inputs.get(evidence.threadId)).toEqual(["Single chunk prompt"]);
    } finally {
      cli.child.kill("SIGKILL");
      await cli.exited;
      await f.close();
    }
  },
);

test(
  "a changed remote public-key pin is fatal instead of entering a reconnect loop",
  { timeout: 30000 },
  async () => {
    const f = await remoteCliFixture();
    try {
      const db = new DatabaseSync(join(f.home, "cli-profiles.sqlite"));
      try {
        const row = z
          .object({ value: z.string() })
          .parse(db.prepare("SELECT value FROM profiles WHERE name=?").get("test-proxy"));
        const profile = z
          .object({ fingerprint: z.string() })
          .passthrough()
          .parse(JSON.parse(row.value));
        profile.fingerprint = "0".repeat(64);
        db.prepare("UPDATE profiles SET value=? WHERE name=?").run(
          JSON.stringify(profile),
          "test-proxy",
        );
      } finally {
        db.close();
      }
      const output = await invoke(f.home, [
        "threads",
        "list",
        ...f.remoteArgs,
        "--json",
        "--timeout",
        "5s",
      ]);
      expect(output.code, output.stderr).toBe(4);
      expect(JSON.parse(output.stdout)).toMatchObject({ status: "refused" });
    } finally {
      await f.close();
    }
  },
);

test(
  "a transient pinned ticket outage reconnects and replays admitted CLI work without running it twice",
  { timeout: 30000 },
  async () => {
    const f = await remoteCliFixture();
    f.loseReplies();
    const args = [
      "run",
      "Replay one remote prompt",
      "--project",
      f.workspace,
      "--idempotency-key",
      "ticket-replay",
      ...f.remoteArgs,
      "--json",
      "--timeout",
      "20s",
    ];
    const cli = startCli(f.home, args);
    try {
      await expect.poll(() => f.receipts.includes("ticket-replay")).toBe(true);
      f.restoreReplies();
      f.interruptWithTicketFailure();
      await expect.poll(f.failedTickets).toBe(1);
      const output = await cli.exited;
      expect(output.code, output.stderr).toBe(0);
      const threadId = z.object({ threadId: ThreadId }).parse(JSON.parse(output.stdout)).threadId;
      await f.daemon.engine?.flush();
      expect(f.h.inputs.get(threadId)).toEqual(["Replay one remote prompt"]);
      expect(f.daemon.store.listThreads().filter((thread) => thread.id === threadId)).toHaveLength(
        1,
      );
    } finally {
      cli.child.kill("SIGKILL");
      await cli.exited;
      await f.close();
    }
  },
);

test.each(["revocation", "quit"] as const)(
  "chat %s aborts a lost receipt, retains its durable key and stops input promptly",
  { timeout: 30000 },
  async (reason) => {
    const f = await remoteCliFixture();
    const cli = openCli(f.home, [
      "chat",
      "--thread",
      f.caller.threadId,
      ...f.remoteArgs,
      "--stream",
      "jsonl",
    ]);
    let output = "";
    cli.child.stdout.on("data", (bytes: Buffer) => {
      output += bytes.toString();
    });
    try {
      await expect.poll(() => output.includes('"type":"thread"')).toBe(true);
      f.loseReplies();
      cli.child.stdin.write("Admitted before losing its receipt\n");
      await expect
        .poll(() => f.commands.find((command) => command.payload.type === "thread.send"))
        .toBeDefined();
      const submitted = f.commands.find((command) => command.payload.type === "thread.send");
      if (!submitted) throw new Error("Missing public command");
      await expect.poll(() => f.receipts.includes(submitted.id)).toBe(true);
      await f.daemon.engine?.flush();
      expect(f.h.inputs.get(f.caller.threadId)).toContain("Admitted before losing its receipt");
      if (reason === "revocation") await f.revoke();
      else cli.child.stdin.write("/quit\n");
      let exited = false;
      void cli.exited.then(() => {
        exited = true;
      });
      await expect.poll(() => exited, { timeout: 5000 }).toBe(true);
      const result = await cli.exited;
      expect(result.code, result.stderr).toBe(5);
      const records = result.stdout
        .trim()
        .split("\n")
        .map((line): unknown => JSON.parse(line));
      expect(records.at(-1)).toMatchObject({
        status: "uncertain",
        admission: { threadId: f.caller.threadId, idempotencyKey: submitted.id },
      });
      const db = new DatabaseSync(join(f.home, "cli-remotes", f.profileId, "cli-outbox.sqlite"));
      try {
        const stored = z
          .object({ value: z.string() })
          .parse(db.prepare("SELECT value FROM intents WHERE id=?").get(submitted.id));
        expect(z.object({ command: Command }).parse(JSON.parse(stored.value)).command).toEqual(
          submitted,
        );
      } finally {
        db.close();
      }
      if (reason === "quit") {
        f.restoreReplies();
        const recovered = await invoke(f.home, [
          "thread",
          "send",
          f.caller.threadId,
          "Admitted before losing its receipt",
          "--idempotency-key",
          submitted.id,
          ...f.remoteArgs,
          "--json",
        ]);
        expect(recovered.code, recovered.stderr).toBe(0);
        await f.daemon.engine?.flush();
        expect(
          f.h.inputs
            .get(f.caller.threadId)
            ?.filter((input) => input === "Admitted before losing its receipt"),
        ).toHaveLength(1);
      }
    } finally {
      cli.child.kill("SIGKILL");
      await cli.exited;
      await f.close();
    }
  },
);
