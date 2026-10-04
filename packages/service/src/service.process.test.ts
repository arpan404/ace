import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "plist";
import { z } from "zod";
import {
  planService,
  ServiceEnvironment,
  UserService,
  runProcess,
  type ServicePlan,
} from "./index.ts";
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
  expect(plist.Label).toBe("dev.ace.next.daemon");
  expect(plist.ProgramArguments).toEqual(["/Users/A & B/.ace/bin/ace", "supervise"]);
  expect(plist.RunAtLoad).toBe(true);
  expect(plist.KeepAlive).toBe(true);
  expect(plist.ThrottleInterval).toBe(15);
  expect(plist.EnvironmentVariables).toEqual({
    ACE_HOME: "/Users/A & B/.ace",
    PATH: "/opt/<tools>:/bin",
    ACE_AUTO_UPDATE: "1",
  });
  expect(plist.StandardOutPath).toBe("/dev/null");
  expect(plist.StandardErrorPath).toBe("/dev/null");
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
      const plan = planService({
        platform,
        home: root,
        dataDir: join(root, "data"),
        executable: join(root, "bin/ace"),
        path: "/bin",
        uid: 1000,
      });
      const service = new UserService(plan, await fakeManager(plan, statePath, executable));
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
      expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
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

async function fakeManager(plan: ServicePlan, statePath: string, executable: string) {
  await writeFile(
    executable,
    `#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
const path=${JSON.stringify(statePath)}, file=${JSON.stringify(plan.file)}, domain=${JSON.stringify(plan.domain)}, mac=${JSON.stringify(plan.platform === "darwin")};
const s=JSON.parse(readFileSync(path,'utf8'));let a=process.argv.slice(2);
if(!mac){if(a.shift()!=='--user')process.exit(64);}
const verb=a[0];
if(mac){
  if(verb==='bootstrap'){if(a.length!==3||a[1]!==domain.slice(0,domain.lastIndexOf('/'))||a[2]!==file)process.exit(64);}
  else if(!['print','bootout'].includes(verb)||a.length!==2||a[1]!==domain)process.exit(64);
}else if(verb==='daemon-reload'){if(a.length!==1)process.exit(64);}
else if(!['show','start','stop','enable','disable'].includes(verb)||a[1]!==domain||(verb==='show'?a.length!==3:a.length!==2))process.exit(64);
if(verb==='print'){
  if(!s.active)process.exit(113);
  const command=${JSON.stringify(plan.command[0])};
  console.log('\\tpath = '+file+'\\n\\tprogram = '+command+'\\n\\targuments = {\\n\\t\\t'+command+'\\n\\t\\tsupervise\\n\\t}');process.exit(0);
}
if(verb==='show'){
  const loaded=s.loaded && (()=>{try{readFileSync(file);return true;}catch{return false;}})();
  const command=${JSON.stringify(plan.command[0])};
  console.log('LoadState='+(loaded?'loaded':'not-found')+'\\nActiveState='+(s.active?'active':'inactive')+'\\nFragmentPath='+(loaded?file:'')+'\\nExecStart='+(loaded?'{ path='+command+' ; argv[]='+command+' supervise ; ignore_errors=no ; }':'')+'\\nExecCondition=\\nExecStartPre=\\nExecStartPost=\\nExecReload=\\nExecStop=\\nExecStopPost=\\nDropInPaths=');process.exit(0);
}
if(verb==='bootstrap'||verb==='start'){s.active=true;s.loaded=readFileSync(file,'utf8');}
if(verb==='bootout'||verb==='stop')s.active=false;
if(verb==='enable'){readFileSync(file);s.enabled=true;}
if(verb==='disable')s.enabled=false;
writeFileSync(path,JSON.stringify(s));
`,
  );
  await chmod(executable, 0o755);
  return (file: string, args: readonly string[]) => {
    if (file !== (plan.platform === "darwin" ? "launchctl" : "systemctl"))
      throw new Error("Unexpected manager");
    return runProcess(executable, args);
  };
}
for (const platform of ["darwin", "linux"] as const)
  test(`${platform} reinstall applies changed daemon ports and PATH to the running service`, async () => {
    const root = await temp(),
      state = join(root, "state.json"),
      executable = join(root, "manager.mjs");
    await writeFile(state, JSON.stringify({ active: false, enabled: false }));
    const input = {
      platform,
      home: root,
      dataDir: join(root, "data"),
      executable: join(root, "bin/ace"),
      path: "/old/bin",
      uid: 501,
      environment: { ACE_PORT: "4000" },
    };
    const original = planService(input),
      run = await fakeManager(original, state, executable);
    await new UserService(original, run).perform("install");
    const changed = planService({ ...input, path: "/new/bin", environment: { ACE_PORT: "5000" } });
    await new UserService(changed, run).perform("install");
    const result = z
      .object({ active: z.boolean(), loaded: z.string() })
      .parse(JSON.parse(await readFile(state, "utf8")));
    expect(result.active).toBe(true);
    if (platform === "darwin")
      expect(
        z
          .object({ EnvironmentVariables: z.record(z.string(), z.string()) })
          .parse(parse(result.loaded)).EnvironmentVariables,
      ).toMatchObject({ ACE_PORT: "5000", PATH: "/new/bin" });
    else {
      expect(result.loaded).toContain("ACE_PORT=5000");
      expect(result.loaded).toContain("PATH=/new/bin");
    }
  });
