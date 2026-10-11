import { execFile } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { createPosixBackendFactory, type TerminalAttachment } from "@ace/terminal";
import { Command } from "@ace/protocol";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { transitionHarness } from "./engine/transition-test-support.ts";

const exec = promisify(execFile);
async function until(stream: TerminalAttachment, marker: string) {
  let output = "";
  for (;;) {
    const next = await stream.next();
    if (next.done) break;
    const event = next.value;
    if (event.type === "data") output += event.data;
    if (output.includes(marker)) return output;
  }
  throw new Error(`Terminal ended before ${marker}`);
}
async function live(pid: number) {
  const { stdout } = await exec("ps", ["-axo", "pid=,stat="]);
  const state = stdout
    .split("\n")
    .find((line) => Number(line.trim().split(/\s+/)[0]) === pid)
    ?.trim()
    .split(/\s+/)[1];
  return state !== undefined && !state.startsWith("Z");
}
function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

test.each(["same thread", "peer thread"])(
  "workspace changes account for disowned jobs after the %s shell exits",
  async (owner) => {
    const h = transitionHarness();
    const backend = createPosixBackendFactory();
    const gate = join(h.home, "gate");
    const written = join(h.home, "late-write");
    const ready = join(h.home, "job-ready");
    let pid: number | undefined;
    const runtime = new WorkspaceRuntime(h.store, h.home, () => 1000, {
      terminal: {
        graceMs: 0,
        dependencies: {
          resolveShell: () => "/bin/bash",
          backendFactory: (options, shell, context) =>
            backend({ ...options, args: ["--noprofile", "--norc", "-i"] }, shell, context),
        },
      },
      async changeWorkspace(id, command, effect, reservation) {
        await h.engine.changeWorkspace(
          id,
          command,
          async () => {
            // The writer would run as soon as a workspace effect begins.
            await writeFile(gate, "go");
            if (pid === undefined) throw new Error("Missing writer PID");
            expect(await live(pid)).toBe(false);
            return effect();
          },
          reservation,
        );
      },
    });
    try {
      await exec("git", ["-C", h.home, "init", "-b", "main"]);
      await writeFile(join(h.home, "file.txt"), "original");
      await exec("git", ["-C", h.home, "add", "file.txt"]);
      await exec("git", [
        "-C",
        h.home,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@ace.local",
        "commit",
        "-m",
        "Initial",
      ]);
      await exec("git", ["-C", h.home, "branch", "feature"]);
      const thread = await h.create();
      const terminalOwner = owner === "same thread" ? thread : await h.create();
      const id = await runtime.openTerminal(terminalOwner, "disowned writer");
      const terminal = runtime.terminal(id, terminalOwner);
      const stream = terminal.attach();
      try {
        terminal.write("stty -echo; set +H; trap '' HUP; printf 'CONFIGURED\\n'\r");
        await until(stream, "CONFIGURED\r\n");
        const code = `const fs=require('node:fs'); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){fs.writeFileSync(${JSON.stringify(written)},'bad');clearInterval(timer);}},10);fs.writeFileSync(${JSON.stringify(ready)},'ready');`;
        terminal.write(
          `${quote(process.execPath)} -e ${quote(code)} </dev/null >/dev/null 2>&1 & printf 'JOB:%s:READY\\n' $!; disown\r`,
        );
        pid = Number((await until(stream, ":READY\r\n")).match(/JOB:(\d+)/)?.[1]);
        expect(pid).toBeGreaterThan(0);
        await expect
          .poll(async () =>
            access(ready).then(
              () => true,
              () => false,
            ),
          )
          .toBe(true);
        terminal.write("exit\r");
        await terminal.exited;
        expect(await live(pid)).toBe(true);
        expect(runtime.liveTerminalCount(terminalOwner)).toBe(1);
        expect(runtime.hasOwnedWork(terminalOwner)).toBe(true);
        const command = Command.parse({
          id: "switch",
          deviceId: "device",
          payload: {
            type: "thread.workspace.set",
            threadId: thread,
            mode: "local",
            branch: "feature",
            allowUncommitted: true,
          },
        });
        if (owner === "peer thread") {
          expect(await runtime.execute(command)).toMatchObject({
            ok: false,
            error: "terminal_owned",
          });
          expect(
            (await exec("git", ["-C", h.home, "branch", "--show-current"])).stdout.trim(),
          ).toBe("main");
          await runtime.closeTerminal(id, terminalOwner);
        }
        expect(
          await runtime.execute(Command.parse({ ...command, id: "switch-after-cleanup" })),
        ).toMatchObject({ ok: true });
        expect(runtime.hasOwnedWork(terminalOwner)).toBe(false);
        expect((await exec("git", ["-C", h.home, "branch", "--show-current"])).stdout.trim()).toBe(
          "feature",
        );
        await expect(access(written)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        stream.detach();
      }
    } finally {
      await runtime.close();
      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Already stopped. */
        }
      }
      await h.close();
    }
  },
);
