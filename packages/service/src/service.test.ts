import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "plist";
import { z } from "zod";
import { planService, ServiceEnvironment, UserService, runProcess } from "./index.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function temp() {
  const root = await mkdtemp(join(tmpdir(), "ace-service-"));
  roots.push(root);
  return root;
}
test("LaunchAgent starts at login with throttled restart and escaped environment", () => {
  const plan = planService({
    platform: "darwin",
    home: "/Users/A & B",
    dataDir: "/Users/A & B/.ace",
    executable: "/Users/A & B/.ace/bin/ace",
    path: "/opt/<tools>:/bin",
    uid: 501,
  });
  const plist = z
    .object({
      Label: z.string(),
      ProgramArguments: z.array(z.string()),
      RunAtLoad: z.boolean(),
      KeepAlive: z.boolean(),
      ThrottleInterval: z.number(),
      EnvironmentVariables: z.record(z.string(), z.string()),
      StandardOutPath: z.string(),
      StandardErrorPath: z.string(),
    })
    .parse(parse(plan.content));
  expect(plist.Label).toBe("dev.ace.daemon");
  expect(plist.ProgramArguments).toEqual(["/Users/A & B/.ace/bin/ace", "supervise"]);
  expect(plist.RunAtLoad).toBe(true);
  expect(plist.KeepAlive).toBe(true);
  expect(plist.ThrottleInterval).toBe(15);
  expect(plist.EnvironmentVariables).toEqual({
    ACE_HOME: "/Users/A & B/.ace",
    PATH: "/opt/<tools>:/bin",
    ACE_AUTO_UPDATE: "1",
  });
  expect(plist.StandardOutPath).toBe("/Users/A & B/.ace/logs/daemon.log");
  expect(plist.StandardErrorPath).toBe("/Users/A & B/.ace/logs/daemon.err.log");
});
test("user systemd unit enables login startup, caps restart frequency and quotes paths", () => {
  const plan = planService({
    platform: "linux",
    home: "/home/a",
    dataDir: "/home/a/.ace",
    executable: '/home/a/100%/$ace/"bin"',
    path: "/bin:/opt/tools",
    uid: 1000,
  });
  const values = new Map(
    plan.content
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
  expect(values.get("WantedBy")).toBe("default.target");
  expect(values.get("Restart")).toBe("always");
  expect(values.get("RestartSec")).toBe("15s");
  expect(values.get("KillMode")).toBe("control-group");
  expect(values.get("StandardOutput")).toBe("journal");
  expect(values.get("ExecStart")).toBe('"/home/a/100%%/$$ace/\\"bin\\"" supervise');
  expect(values.get("Environment")).toBe(
    '"ACE_HOME=/home/a/.ace" "PATH=/bin:/opt/tools" "ACE_AUTO_UPDATE=1"',
  );
});
for (const platform of ["darwin", "linux"] as const)
  test(
    `${platform} installation, start, stop and removal reconcile repeated operations`,
    { timeout: 60_000 },
    async () => {
      const root = await temp(),
        statePath = join(root, "state.json"),
        executable = join(root, "manager.mjs");
      await writeFile(statePath, JSON.stringify({ active: false, enabled: false }));
      await writeFile(
        executable,
        `#!/usr/bin/env node\nimport {readFileSync,writeFileSync} from 'node:fs';
const path=${JSON.stringify(statePath)}; const s=JSON.parse(readFileSync(path,'utf8')); const a=process.argv.slice(2).filter(x=>x!=='--user');
if(a[0]==='print'||a[0]==='is-active') process.exit(s.active?0:(a[0]==='print'?113:3));
if(a[0]==='bootstrap'||a[0]==='start') s.active=true;
if(a[0]==='bootout'||a[0]==='stop') s.active=false;
if(a[0]==='enable') s.enabled=true;
if(a[0]==='disable') s.enabled=false;
writeFileSync(path,JSON.stringify(s));\n`,
      );
      await chmod(executable, 0o755);
      const plan = planService({
        platform,
        home: root,
        dataDir: join(root, "data"),
        executable: join(root, "bin/ace"),
        path: "/bin",
        uid: 1000,
      });
      const service = new UserService(plan, (_file, args) => runProcess(executable, args));
      await service.perform("install");
      await service.perform("install");
      await service.perform("start");
      expect(await service.perform("status")).toEqual({ active: true });
      expect(await readFile(plan.file, "utf8")).toBe(plan.content);
      await service.perform("stop");
      await service.perform("stop");
      expect(await service.active()).toBe(false);
      await service.perform("start");
      expect(await service.active()).toBe(true);
      await service.perform("uninstall");
      await service.perform("uninstall");
      expect(await service.active()).toBe(false);
      await expect(readFile(plan.file)).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({
        active: false,
        enabled: false,
      });
    },
  );
test("a broken service manager is reported instead of silently treated as stopped", async () => {
  const p = planService({
    platform: "linux",
    home: "/home/a",
    dataDir: "/home/a/.ace",
    executable: "/home/a/.ace/bin/ace",
    path: "/bin",
    uid: 1000,
  });
  await expect(
    new UserService(p, async () => ({ code: 1, stdout: "", stderr: "bus unavailable" })).perform(
      "status",
    ),
  ).rejects.toThrow();
});
test("service environment preserves daemon network settings while excluding provider secrets", () => {
  const environment = ServiceEnvironment.parse({
    ACE_PORT: "4545",
    ACE_LISTEN: "lan",
    ACE_ADVERTISE_HOST: "host.local",
    PROVIDER_API_KEY: "must-not-persist",
  });
  const p = planService({
    platform: "darwin",
    home: "/Users/a",
    dataDir: "/Users/a/.ace",
    executable: "/Users/a/.ace/bin/ace",
    path: "/bin",
    uid: 501,
    environment,
  });
  const decoded = z
    .object({ EnvironmentVariables: z.record(z.string(), z.string()) })
    .parse(parse(p.content));
  expect(decoded.EnvironmentVariables).toMatchObject({
    ACE_PORT: "4545",
    ACE_LISTEN: "lan",
    ACE_ADVERTISE_HOST: "host.local",
  });
  expect(p.content).not.toContain("must-not-persist");
});
