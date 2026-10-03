import { expect, test } from "vitest";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { ConductorRunView } from "@ace/protocol";

const Message = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("send"),
    thread: z.string(),
    text: z.string(),
    resumed: z.boolean(),
    cwd: z.string(),
  }),
  z.object({
    type: z.literal("boundary"),
    thread: z.string().optional(),
    run: ConductorRunView.optional(),
  }),
  z.object({
    type: z.literal("done"),
    run: ConductorRunView,
    sends: z.array(
      z.object({ thread: z.string(), text: z.string(), resumed: z.boolean(), cwd: z.string() }),
    ),
  }),
]);
function child(home: string, scenario: string, mode: string) {
  const process = fork(new URL("./deck-crash-child.ts", import.meta.url), [home, scenario, mode], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const sends: z.infer<typeof Message>[] = [];
  const milestone = new Promise<z.infer<typeof Message>>((resolve, reject) => {
    // Real Node bootstrap, SQLite recovery and Git I/O cannot use a manual clock.
    // The IPC milestone has a bounded safety deadline; no progress polling.
    const deadline = setTimeout(
      () => reject(new Error(`Daemon ${scenario}/${mode} did not reach its IPC milestone`)),
      30_000,
    );
    process.on("message", (input) => {
      const message = Message.parse(input);
      sends.push(message);
      if (message.type === "boundary" || message.type === "done") {
        clearTimeout(deadline);
        resolve(message);
      }
    });
    process.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    process.once("exit", () => {
      clearTimeout(deadline);
      reject(new Error("Daemon exited before committed milestone"));
    });
  });
  async function kill() {
    if (process.exitCode !== null || process.signalCode !== null) return;
    const exited = once(process, "exit");
    process.kill("SIGKILL");
    await exited;
  }
  return { milestone, sends, kill };
}
// Scripted provider boundary; no installed provider CLIs are invoked. The parent never calls daemon.close().
for (const scenario of ["work", "switch"] as const) {
  test(
    scenario === "work"
      ? "a killed daemon resumes its empty-outbox Deck in the original worker thread"
      : "a killed running switch is replaced and the Deck resumes on its applied provider",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "deck-crash-"));
      const first = child(home, scenario, "first");
      let recovered: ReturnType<typeof child> | undefined;
      try {
        const before = await first.milestone;
        if (before.type !== "boundary") throw new Error("Crash boundary missing");
        const thread =
          before.thread ??
          before.run?.delegations.find((edge) => edge.workstream === "a")?.threadId;
        if (!thread) throw new Error("Worker identity missing");
        expect(
          first.sends.filter(
            (message) => message.type === "send" && message.thread === thread && !message.resumed,
          ),
        ).toHaveLength(1);
        await first.kill();
        recovered = child(home, scenario, "recover");
        const after = await recovered.milestone;
        if (after.type !== "done") throw new Error("Recovered run missing");
        expect(after.run.phase).toBe("done");
        const worker = after.run.delegations.find((edge) => edge.threadId === thread);
        expect(worker?.phase).toBe("settled");
        if (scenario === "work") {
          expect(after.run.startedAt).toBe(before.run?.startedAt);
          expect(after.sends.filter((send) => send.thread === thread && send.resumed)).toHaveLength(
            1,
          );
          expect(
            after.sends.filter((send) => send.thread === thread && !send.resumed),
          ).toHaveLength(0);
        } else {
          expect(worker?.provider).toBe("claude");
          expect(worker?.account).toBe("local.claude");
          expect(worker?.generation).toBe(1);
        }
      } finally {
        await first.kill();
        await recovered?.kill();
        await rm(home, { recursive: true, force: true });
      }
    },
  );
}
