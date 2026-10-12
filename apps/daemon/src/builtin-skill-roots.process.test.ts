import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { prepareBuiltinSkills } from "@ace/plugins";
import { spawnSupervised } from "@ace/provider-kit/process";
import {
  ProcessIdentity,
  processIdentity,
  processGroupIsGone,
} from "@ace/provider-kit/process-identity";
import { builtinSkillRecovery, createBuiltinSkillRoot } from "./builtin-skill-roots.ts";
import { builtinSkillProcessLease, skillProcessRuntime } from "./builtin-skill-processes.ts";

const skillPath = (root: string) =>
  join(root, "generated/plugins/ace-builtins/skills/visualize/SKILL.md");
const Ready = z.object({ root: z.string(), identity: ProcessIdentity });

async function inactiveProjection(dataDir: string): Promise<string> {
  const root = await createBuiltinSkillRoot(dataDir);
  await prepareBuiltinSkills("claude", root);
  const lease = builtinSkillProcessLease(root);
  const provider = spawnSupervised({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    env: {},
    name: "inactive-skill-fixture",
    lease,
  });
  await provider.stop({ graceMs: 0 });
  lease.close();
  return root;
}

test("a detached provider keeps its skill projection after daemon SIGKILL, and restart reclaims it only after it is gone", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ace-skill-crash-"));
  const daemon = fork(new URL("./builtin-skill-crash-child.ts", import.meta.url), [dataDir], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let provider: ProcessIdentity | undefined;
  try {
    const ready = await new Promise<z.infer<typeof Ready>>((resolve, reject) => {
      daemon.once("message", (message: unknown) => {
        const result = Ready.safeParse(message);
        if (result.success) resolve(result.data);
        else reject(result.error);
      });
      daemon.once("error", reject);
      daemon.once("exit", () => reject(new Error("Fixture daemon exited before readiness")));
    });
    provider = ready.identity;
    const crashed = once(daemon, "exit");
    daemon.kill("SIGKILL");
    await crashed;
    const collect = await builtinSkillRecovery(dataDir);
    const errors: unknown[] = [];
    await collect(Promise.resolve(), (error) => errors.push(error));
    expect(errors).toEqual([]);
    expect(await readFile(skillPath(ready.root), "utf8")).toContain("ace_html_render");
    process.kill(provider.pid, "SIGKILL");
    await expect
      .poll(
        () =>
          processGroupIsGone(ready.identity.group) &&
          processIdentity(ready.identity.pid) === undefined,
      )
      .toBe(true);
    const restarted = await builtinSkillRecovery(dataDir);
    await restarted(Promise.resolve(), (error) => errors.push(error));
    expect(errors).toEqual([]);
    await expect(readFile(skillPath(ready.root))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    daemon.kill("SIGKILL");
    if (provider && processIdentity(provider.pid)?.start === provider.start)
      process.kill(provider.pid, "SIGKILL");
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("restart waits for recovery and preserves projections created after its startup snapshot", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ace-skill-restart-"));
  try {
    const abandoned = await inactiveProjection(dataDir);
    const unowned = await createBuiltinSkillRoot(dataDir);
    await writeFile(join(unowned, "person.md"), "Keep this file");
    const collect = await builtinSkillRecovery(dataDir);
    const active = await createBuiltinSkillRoot(dataDir);
    await prepareBuiltinSkills("codex", active);
    builtinSkillProcessLease(active).close(); // Eligible but outside the startup snapshot.
    const recovered = Promise.withResolvers<void>();
    const collecting = collect(recovered.promise, () => {});
    expect(await readFile(skillPath(abandoned), "utf8")).toContain("ace_html_render");
    recovered.resolve();
    await collecting;
    await expect(readFile(skillPath(abandoned))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(skillPath(active), "utf8")).toContain("ace_html_render");
    expect(await readFile(join(unowned, "person.md"), "utf8")).toBe("Keep this file");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("missing ownership evidence, interrupted spawn recording and unverifiable liveness retain skill projections", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ace-skill-uncertain-"));
  try {
    const legacy = await createBuiltinSkillRoot(dataDir);
    await prepareBuiltinSkills("codex", legacy);
    const pending = await createBuiltinSkillRoot(dataDir);
    await prepareBuiltinSkills("codex", pending);
    const lease = builtinSkillProcessLease(pending);
    lease.preparing(); // Crash between native spawn and recording its kernel identity.
    lease.close();
    const unavailable = await inactiveProjection(dataDir);
    const collect = await builtinSkillRecovery(dataDir, {
      ...skillProcessRuntime,
      identity() {
        throw new Error("Kernel inspection denied");
      },
    });
    await collect(Promise.resolve(), () => {});
    for (const root of [legacy, pending, unavailable])
      expect(await readFile(skillPath(root), "utf8")).toContain("ace_html_render");
    // A working inspector still cannot establish whether the interrupted spawn produced a child.
    const retry = await builtinSkillRecovery(dataDir);
    await retry(Promise.resolve(), () => {});
    expect(await readFile(skillPath(pending), "utf8")).toContain("ace_html_render");
    expect(await readFile(skillPath(legacy), "utf8")).toContain("ace_html_render");
    await expect(readFile(skillPath(unavailable))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("failed recovery leaves the previous projection available", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ace-skill-recovery-"));
  try {
    const abandoned = await inactiveProjection(dataDir);
    const collect = await builtinSkillRecovery(dataDir);
    await expect(collect(Promise.reject(new Error("Recovery failed")), () => {})).rejects.toThrow(
      "Recovery failed",
    );
    expect(await readFile(skillPath(abandoned), "utf8")).toContain("ace_html_render");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("changed UID or group retains a live provider, while a recycled PID does not keep an exited provider's projection", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ace-skill-identity-"));
  const root = await createBuiltinSkillRoot(dataDir);
  await prepareBuiltinSkills("codex", root);
  const lease = builtinSkillProcessLease(root);
  const provider = spawnSupervised({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    env: {},
    name: "skill-identity-fixture",
    lease,
  });
  try {
    if (!provider.pid) throw new Error("Provider was not spawned");
    const identity = processIdentity(provider.pid);
    if (!identity) throw new Error("Provider identity unavailable");
    lease.close();
    const changed = await builtinSkillRecovery(dataDir, {
      ...skillProcessRuntime,
      identity(pid) {
        return pid === identity.pid
          ? { ...identity, uid: identity.uid + 1, group: identity.group + 1 }
          : skillProcessRuntime.identity(pid);
      },
      groupGone() {
        return true;
      }, // Original group disappeared, but the same process still lives.
    });
    await changed(Promise.resolve(), () => {});
    expect(await readFile(skillPath(root), "utf8")).toContain("ace_html_render");
    await provider.stop({ graceMs: 0 });
    const recycled = await builtinSkillRecovery(dataDir, {
      ...skillProcessRuntime,
      identity(pid) {
        return pid === identity.pid
          ? { ...identity, start: `${identity.start}:reused` }
          : skillProcessRuntime.identity(pid);
      },
    });
    await recycled(Promise.resolve(), () => {});
    await expect(readFile(skillPath(root))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await provider.stop({ graceMs: 0 });
    await rm(dataDir, { recursive: true, force: true });
  }
});
