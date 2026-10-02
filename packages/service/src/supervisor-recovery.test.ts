import { expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, readlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { atomicPointer, snapshotDatabases, runSupervisor, BoundedLog } from "./index.ts";

function noop() {}
function deferred<T>() {
  let resolve: (value: T) => void = noop;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function kill(child: ChildProcess | undefined) {
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = once(child, "close");
    child.kill("SIGKILL");
    await closed;
  }
}
test.each(["uncommitted", "committed"])(
  "%s recovery retries after the transaction owner dies even with automatic updates disabled",
  async (commit) => {
    const root = await mkdtemp(join(tmpdir(), "ace-recovery-"));
    const api = fileURLToPath(new URL("./index.ts", import.meta.url));
    let owner: ChildProcess | undefined,
      daemon: ChildProcess | undefined,
      stop = noop,
      supervisor: Promise<number> | undefined;
    const updaters: ChildProcess[] = [];
    try {
      const old = "releases/1.0.0-linux-x64",
        candidate = "releases/1.1.0-linux-x64";
      await mkdir(join(root, old), { recursive: true });
      await mkdir(join(root, candidate), { recursive: true });
      await atomicPointer(join(root, "current"), candidate);
      const db = new DatabaseSync(join(root, "events.sqlite"));
      db.exec("CREATE TABLE content(value TEXT); INSERT INTO content VALUES('original')");
      db.close();
      const databases = await snapshotDatabases(root, join(root, ".rollback-db"));
      const changed = new DatabaseSync(join(root, "events.sqlite"));
      changed.exec("UPDATE content SET value='candidate'");
      changed.close();
      await writeFile(
        join(root, "update.json"),
        JSON.stringify({ old, candidate, version: "1.0.0", stage: "snapshotted", databases }),
      );
      owner = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const {withInstallLock}=await import(${JSON.stringify(api)});await withInstallLock(${JSON.stringify(root)},async()=>{process.stdout.write('locked');setInterval(()=>{},1000);await new Promise(()=>{})});`,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      // The interval owns a process handle; readiness and retry use explicit events, not time.
      if (!owner.stdout) throw new Error("Missing owner readiness pipe");
      await once(owner.stdout, "data");
      const scheduled = deferred<() => void>(),
        recovered = deferred<void>(),
        contended = deferred<void>();
      supervisor = runSupervisor({
        output: new BoundedLog(join(root, "output.log")),
        errors: new BoundedLog(join(root, "error.log")),
        dailyUpdates: false,
        journalPending: () => existsSync(join(root, "update.json")),
        schedule(_ms, callback) {
          scheduled.resolve(callback);
          return () => {};
        },
        subscribeStop(callback) {
          stop = callback;
          return () => {};
        },
        report: () => {},
        spawnDaemon() {
          daemon = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
            stdio: ["ignore", "pipe", "pipe"],
          });
          return daemon;
        },
        launchUpdate(command) {
          if (command !== "recover") throw new Error("manual update policy was bypassed");
          const child = spawn(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              `
          const {withInstallLock,recoverUpdate}=await import(${JSON.stringify(api)});
          try {await withInstallLock(${JSON.stringify(root)},async()=>{await recoverUpdate(${JSON.stringify(root)},${JSON.stringify(root)},{stop:async()=>{},start:async()=>{},health:async()=>true,maintenance:async()=>({draining:true,blockers:0}),migrate:async()=>{},wait:async()=>{},now:()=>0});const {writeFile}=await import("node:fs/promises");await writeFile(${JSON.stringify(join(root, "admission"))},"open");});process.stdout.write('recovered');}
          catch(error){process.stdout.write(error.message);process.exitCode=1;}
        `,
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          updaters.push(child);
          let output = "";
          child.stdout.on("data", (chunk: Buffer) => {
            output = (output + chunk.toString()).slice(-4096);
            if (output.includes("locked")) contended.resolve();
            if (output.includes("recovered")) recovered.resolve();
          });
          return child;
        },
      });
      await contended.promise;
      const retry = await scheduled.promise;
      if (commit === "committed") await rm(join(root, "update.json"));
      await kill(owner);
      retry();
      await recovered.promise;
      expect(await readlink(join(root, "current"))).toBe(commit === "committed" ? candidate : old);
      expect(await readFile(join(root, "admission"), "utf8")).toBe("open");
      await expect(readFile(join(root, "update.json"))).rejects.toMatchObject({ code: "ENOENT" });
      const restored = new DatabaseSync(join(root, "events.sqlite"), { readOnly: true });
      try {
        expect(restored.prepare("SELECT value FROM content").get()?.value).toBe(
          commit === "committed" ? "candidate" : "original",
        );
      } finally {
        restored.close();
      }
      stop();
      await supervisor;
    } finally {
      stop();
      await kill(owner);
      await kill(daemon);
      await Promise.all(updaters.map(kill));
      await supervisor?.catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  },
);
