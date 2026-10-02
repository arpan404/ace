import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { GitService } from "./index.ts";
import { execute, repository, scratch } from "./test-repo.ts";

test("the injected spawner can route an executable to real Git", async () => {
  const repo = await repository();
  const service = new GitService({
    gitBinary: "ace-test-routed-git",
    processRuntime: { spawn: (_command, args, options) => spawn("git", args, options) },
  });
  expect(await service.repositoryInfo(repo)).toMatchObject({ root: repo, branch: "main" });
});

test.each(["darwin", "win32"] as const)(
  "the injected deadline kills a ready parent and descendant using the %s strategy",
  async (platform) => {
    const directory = await scratch();
    const descendantFile = join(directory, "descendant.cjs");
    const parentFile = join(directory, "parent.cjs");
    const taskkillFile = join(directory, "taskkill.cjs");
    await writeFile(
      descendantFile,
      "process.on('message',()=>{process.send({pid:process.pid});}); process.send({pid:process.pid}); setInterval(()=>{},1000);",
    );
    await writeFile(
      parentFile,
      `
   if(process.argv.includes('--version')) {process.stdout.write('git version 2.40.0\\n');}
   else {const child=require('node:child_process').fork(${JSON.stringify(descendantFile)},[],{stdio:['ignore',process.stdout,process.stderr,'ipc']});
    child.once('message',message=>process.stderr.write(JSON.stringify({parent:process.pid,descendant:message.pid})+'\\n'));
    child.once('exit',()=>require('node:fs').writeFileSync(${JSON.stringify(join(directory, "reaped"))},'reaped'));}
  `,
    );
    // Execute the Windows command strategy against real processes on this host.
    // The replacement is only the OS-specific taskkill executable boundary.
    await writeFile(
      taskkillFile,
      `
   const fs=require('node:fs');const {parent,descendant}=JSON.parse(fs.readFileSync(${JSON.stringify(join(directory, "pids.json"))},'utf8'));
   const args=process.argv.slice(2);
   if(args.join(' ') !== '/PID '+parent+' /T /F') process.exit(22);
   const watcher=fs.watch(${JSON.stringify(directory)},(_event,name)=>{
    if(name!=='reaped') return; watcher.close();process.kill(parent,'SIGKILL');
   });
   process.kill(descendant,'SIGKILL');
  `,
    );
    const ready = Promise.withResolvers<{ parent: number; descendant: number }>();
    const exited = Promise.withResolvers<void>();
    const deadlines = new Set<() => void>();
    const operation = new GitService({
      gitBinary: "ace-timeout-fixture",
      processRuntime: {
        platform,
        spawn: (command, args, options) => {
          const executable = command === "taskkill" ? taskkillFile : parentFile;
          const child = spawn(process.execPath, [executable, ...args], {
            ...options,
            detached: platform !== "win32",
          });
          if (command !== "taskkill" && !args.includes("--version"))
            child.once("exit", () => exited.resolve());
          if (command !== "taskkill")
            child.stderr.on("data", (bytes: Buffer) => {
              const result = z
                .object({
                  parent: z.number().int().positive(),
                  descendant: z.number().int().positive(),
                })
                .safeParse(JSON.parse(bytes.toString()));
              if (result.success) {
                void writeFile(join(directory, "pids.json"), JSON.stringify(result.data)).then(() =>
                  ready.resolve(result.data),
                );
              }
            });
          return child;
        },
        scheduleTimeout: (callback) => {
          deadlines.add(callback);
          return () => {
            deadlines.delete(callback);
          };
        },
      },
    }).repositoryInfo(directory);
    const rejected = expect(operation).rejects.toMatchObject({ code: "git_timeout" });
    const pids = await ready.promise;
    try {
      // Callbacks can register the taskkill helper deadline; expire only the original calls.
      const due = Array.from(deadlines);
      for (const expire of due) expire();
      await exited.promise;
      expect(() => process.kill(pids.parent, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
      if (platform === "win32") {
        expect(() => process.kill(pids.descendant, 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
      } else {
        // An orphan can be exiting or a zombie before the host reaps it.
        // A surviving descendant is still running/sleeping in ps.
        let exists = true;
        try {
          process.kill(pids.descendant, 0);
        } catch (error) {
          expect(error).toMatchObject({ code: "ESRCH" });
          exists = false;
        }
        if (exists) {
          const state = await execute("ps", ["-o", "stat=", "-p", String(pids.descendant)], {
            timeout: 30_000,
          }).catch((error) => {
            expect(error).toMatchObject({ code: 1, stdout: "" });
            return { stdout: "" };
          });
          expect(state.stdout.trim()).toMatch(/^(?:Z[^\n]*|\?E[^\n]*)?$/);
        }
      }
    } finally {
      for (const pid of Object.values(pids)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Already dead. */
        }
      }
      await rejected;
    }
  },
);
