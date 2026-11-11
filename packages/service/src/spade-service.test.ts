import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import type { Runner } from "./process.ts";
import { spadeServicePlan, type SpadeServicePlan } from "./spade-plan.ts";
import { installSpadeBinary } from "./spade-release.ts";
import {
  installSpadeService,
  removeSpadeService,
  restartSpadeService,
  spadeServiceState,
} from "./spade-service.ts";

async function setup(
  platform: "darwin" | "linux",
  onTestFinished: (fn: () => Promise<void>) => void,
) {
  const root = await mkdtemp(join(tmpdir(), "ace-spade-service-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const home = join(root, ".ace");
  await mkdir(home);
  const plan = spadeServicePlan(home, platform, { userHome: root, uid: 501 });
  return { root, home, plan };
}

async function withBinary(root: string, home: string) {
  const source = join(root, "spade-server");
  await writeFile(source, "#!/bin/sh\n", { mode: 0o755 });
  await installSpadeBinary(home, source, "0.4.0");
}

/** A launchd or systemd that loads what it is given, reporting `program` as the loaded one. */
function manager(plan: SpadeServicePlan, program = plan.command[0] ?? "") {
  const calls: string[] = [];
  let loaded = false;
  let running = false;
  const run: Runner = async (file, args) => {
    const command = `${file} ${args.join(" ")}`;
    if (args.includes("print") || args.includes("show")) {
      if (plan.platform === "darwin")
        return loaded
          ? {
              code: 0,
              stderr: "",
              stdout: `\tpath = ${plan.file}\n\tstate = ${running ? "running" : "waiting"}\n\tprogram = ${program}\n\targuments = {\n\t\t${program}\n\t}\n`,
            }
          : { code: 113, stderr: "", stdout: "" };
      return {
        code: 0,
        stderr: "",
        stdout: loaded
          ? `LoadState=loaded\nActiveState=${running ? "active" : "inactive"}\nFragmentPath=${plan.file}\nExecStart={ path=${program} ; argv[]=${program} ; ignore_errors=no ; }\n`
          : "LoadState=not-found\nActiveState=inactive\n",
      };
    }
    calls.push(command);
    if (args.includes("bootstrap")) loaded = true;
    if (args.includes("daemon-reload")) loaded = existsSync(plan.file);
    if (args.includes("bootstrap") || args.includes("restart") || args.includes("start"))
      running = true;
    if (args.includes("kickstart")) running = true;
    if (args.includes("bootout") || args.includes("disable")) loaded = running = false;
    if (args.includes("stop")) running = false;
    return { code: 0, stdout: "", stderr: "" };
  };
  return { calls, ports: { run, wait: async () => {} } };
}

test("Spade's service is absent until it is registered", async ({ onTestFinished }) => {
  const { plan } = await setup("darwin", onTestFinished);
  expect(await spadeServiceState(plan, manager(plan).ports)).toBe("absent");
});

test("registering Spade needs its binary installed first", async ({ onTestFinished }) => {
  const { plan } = await setup("darwin", onTestFinished);
  const fake = manager(plan);
  await expect(installSpadeService(plan, fake.ports)).rejects.toThrow(/binary/);
  expect(fake.calls).toEqual([]);
  await expect(readFile(plan.file)).rejects.toMatchObject({ code: "ENOENT" });
});

for (const platform of ["darwin", "linux"] as const)
  test(`${platform}: install registers and runs Spade, remove takes it away again`, async ({
    onTestFinished,
  }) => {
    const { root, home, plan } = await setup(platform, onTestFinished);
    await withBinary(root, home);
    const fake = manager(plan);
    expect(await installSpadeService(plan, fake.ports)).toBe("running");
    expect(await readFile(plan.file, "utf8")).toBe(plan.content);
    expect(await removeSpadeService(plan, fake.ports)).toBe("absent");
    await expect(readFile(plan.file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await spadeServiceState(plan, fake.ports)).toBe("absent");
    // A second removal changes nothing.
    const before = fake.calls.length;
    expect(await removeSpadeService(plan, fake.ports)).toBe("absent");
    expect(fake.calls.length).toBe(before);
  });

for (const platform of ["darwin", "linux"] as const)
  test(`${platform}: an edited registration is refused before the manager is touched`, async ({
    onTestFinished,
  }) => {
    const { root, home, plan } = await setup(platform, onTestFinished);
    await withBinary(root, home);
    await mkdir(dirname(plan.file), { recursive: true });
    const tampered = plan.content.replace("RUST_LOG", "DYLD_INSERT_LIBRARIES");
    await writeFile(plan.file, tampered);
    const fake = manager(plan);
    for (const action of [
      spadeServiceState,
      installSpadeService,
      removeSpadeService,
      restartSpadeService,
    ])
      await expect(action(plan, fake.ports)).rejects.toThrow(/Incompatible Spade service/);
    expect(fake.calls).toEqual([]);
    expect(await readFile(plan.file, "utf8")).toBe(tampered);
  });

for (const platform of ["darwin", "linux"] as const)
  test(`${platform}: a loaded service running another program is refused`, async ({
    onTestFinished,
  }) => {
    const { root, home, plan } = await setup(platform, onTestFinished);
    await withBinary(root, home);
    const fake = manager(plan, join(root, "elsewhere/spade-server"));
    await installSpadeService(plan, fake.ports).catch(() => {});
    await expect(spadeServiceState(plan, fake.ports)).rejects.toThrow(/Incompatible Spade service/);
  });

test("the updater's restart never registers an absent service", async ({ onTestFinished }) => {
  const { root, home, plan } = await setup("linux", onTestFinished);
  await withBinary(root, home);
  const fake = manager(plan);
  await expect(restartSpadeService(plan, fake.ports)).rejects.toThrow(/not registered/);
  expect(fake.calls).toEqual([]);
});

test("restart starts Spade again on the current binary", async ({ onTestFinished }) => {
  const { root, home, plan } = await setup("darwin", onTestFinished);
  await withBinary(root, home);
  const fake = manager(plan);
  await installSpadeService(plan, fake.ports);
  await restartSpadeService(plan, fake.ports);
  expect(fake.calls.at(-1)).toBe("launchctl kickstart -k gui/501/dev.ace.next.spade");
  expect(await spadeServiceState(plan, fake.ports)).toBe("running");
});
