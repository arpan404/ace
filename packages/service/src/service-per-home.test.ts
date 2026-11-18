import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { expect, test } from "vitest";
import { planService, planTask, type ServicePlan } from "./plan.ts";
import type { Runner } from "./process.ts";
import { UserService } from "./service.ts";
import { registeredSpadeHome, spadeServicePlan, type SpadeServicePlan } from "./spade-plan.ts";
import { spadePlanBesideShared } from "./spade-local.ts";
import { installSpadeBinary } from "./spade-release.ts";
import { installSpadeService, removeSpadeService, spadeServiceState } from "./spade-service.ts";

/** A person's folder with the default home `.ace` and a dev home beside it. */
async function machine(onTestFinished: (fn: () => Promise<void>) => void) {
  const user = await mkdtemp(join(tmpdir(), "ace-service-per-home-"));
  onTestFinished(() => rm(user, { recursive: true, force: true }));
  const main = join(user, ".ace");
  const dev = join(user, "dev-home");
  await mkdir(main);
  await mkdir(dev);
  return { user, main, dev };
}

async function withSpadeBinary(home: string) {
  const source = join(dirname(home), `spade-${basename(home)}`);
  await writeFile(source, "#!/bin/sh\n", { mode: 0o755 });
  await installSpadeBinary(home, source, "0.4.0");
}

/** The program a registration runs, as launchd or systemd would load it from the file. */
function loadedCommand(file: string): string[] {
  const content = readFileSync(file, "utf8");
  if (file.endsWith(".plist"))
    return [
      ...(/<key>ProgramArguments<\/key><array>(.*?)<\/array>/s.exec(content)?.[1] ?? "").matchAll(
        /<string>([^<]*)<\/string>/g,
      ),
    ].map((match) => match[1] ?? "");
  const start = /^ExecStart="([^"]*)"(.*)$/m.exec(content);
  return [start?.[1] ?? "", ...(start?.[2] ?? "").split(" ").filter(Boolean)];
}

/**
 * One user's launchd or systemd holding any number of services, each loaded from its file
 * under `user`. Every change is recorded with the service it touched.
 */
function serviceManager(user: string) {
  const loaded = new Set<string>();
  const running = new Set<string>();
  const changes: string[] = [];
  const fileOf = (name: string) =>
    name.startsWith("gui/")
      ? join(user, "Library/LaunchAgents", `${name.slice(name.lastIndexOf("/") + 1)}.plist`)
      : join(user, ".config/systemd/user", name);
  const run: Runner = async (file, args) => {
    const [verb, name = ""] = file === "systemctl" ? args.slice(1) : args;
    if (verb === "show" || verb === "print") {
      if (!loaded.has(name))
        return file === "launchctl"
          ? { code: 113, stdout: "", stderr: "" }
          : { code: 0, stdout: "LoadState=not-found\nActiveState=inactive\n", stderr: "" };
      const command = loadedCommand(fileOf(name));
      const stdout =
        file === "launchctl"
          ? `\tpath = ${fileOf(name)}\n\tstate = ${running.has(name) ? "running" : "waiting"}\n\tprogram = ${command[0]}\n\targuments = {\n${command.map((arg) => `\t\t${arg}\n`).join("")}\t}\n`
          : `LoadState=loaded\nActiveState=${running.has(name) ? "active" : "inactive"}\nFragmentPath=${fileOf(name)}\nExecStart={ path=${command[0]} ; argv[]=${command.join(" ")} ; ignore_errors=no ; }\n`;
      return { code: 0, stdout, stderr: "" };
    }
    if (verb === "daemon-reload") {
      for (const unit of loaded) if (!existsSync(fileOf(unit))) loaded.delete(unit);
      return { code: 0, stdout: "", stderr: "" };
    }
    // launchd's bootstrap names the domain and the file; the job is the file's label.
    const job = verb === "bootstrap" ? `${name}/${basename(args[2] ?? "", ".plist")}` : name;
    changes.push(`${verb} ${job}`);
    if (verb === "enable" || verb === "bootstrap") loaded.add(job);
    if (["start", "restart", "bootstrap", "kickstart"].includes(verb ?? "")) running.add(job);
    if (verb === "stop") running.delete(job);
    if (verb === "bootout" || verb === "disable") {
      running.delete(job);
      loaded.delete(job);
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, changes, ports: { run, wait: async () => {} } };
}

const account = (user: string) => ({ userHome: user, uid: 501 });
const serviceName = (plan: SpadeServicePlan) =>
  plan.platform === "linux" ? plan.unit : plan.platform === "darwin" ? plan.domain : plan.name;

/** The daemon's service for `home` in `/home/a`'s account. */
const daemon = (platform: "darwin" | "linux", home = "/home/a/.ace") =>
  planService({
    platform,
    home: "/home/a",
    dataDir: home,
    executable: `${home}/bin/ace`,
    path: "/bin",
    uid: 501,
  });

/** Spade's and the daemon's names for `home` on macOS and Linux. */
const names = (home: string) => [
  serviceName(spadeServicePlan(home, "darwin", { userHome: "/home/a", uid: 501 })),
  serviceName(spadeServicePlan(home, "linux", { userHome: "/home/a" })),
  daemon("darwin", home).domain,
  daemon("linux", home).domain,
];

const windowsSpadeName = (home: string) =>
  serviceName(
    spadeServicePlan(home, "win32", { userHome: "C:\\Users\\a", sid: "S-1-5-21-1-2-3-1001" }),
  );

test("the default home keeps its existing service names on every OS", () => {
  const mac = spadeServicePlan("/Users/a/.ace", "darwin", { userHome: "/Users/a", uid: 501 });
  const linux = spadeServicePlan("/home/a/.ace/", "linux", { userHome: "/home/a" });
  const windows = spadeServicePlan("C:\\Users\\A\\.ACE", "win32", {
    userHome: "C:\\Users\\a",
    sid: "S-1-5-21-1-2-3-1001",
  });
  expect([serviceName(mac), mac.file]).toEqual([
    "gui/501/dev.ace.next.spade",
    "/Users/a/Library/LaunchAgents/dev.ace.next.spade.plist",
  ]);
  expect([serviceName(linux), linux.file]).toEqual([
    "ace-next-spade.service",
    "/home/a/.config/systemd/user/ace-next-spade.service",
  ]);
  expect(serviceName(windows)).toBe("\\ace-next-spade");

  expect(daemon("darwin").domain).toBe("gui/501/dev.ace.next.daemon");
  expect(daemon("linux").domain).toBe("ace-next.service");
  expect(
    planTask({
      dataDir: "C:\\Users\\a\\.ace",
      executable: "C:\\Users\\a\\.ace\\bin\\ace.cmd",
      path: "C:\\Windows\\System32",
      user: "S-1-5-21-1-2-3-1001",
      systemRoot: "C:\\Windows",
      userHome: "C:\\Users\\a",
    }).name,
  ).toBe("\\ace-next-daemon");
});

test("every other home gets its own stable service name on every OS", () => {
  const dev = names("/home/a/.ace/dev");
  expect(dev).toEqual([
    expect.stringMatching(/^gui\/501\/dev\.ace\.next\.spade\.[0-9a-f]{10}$/),
    expect.stringMatching(/^ace-next-spade-[0-9a-f]{10}\.service$/),
    expect.stringMatching(/^gui\/501\/dev\.ace\.next\.daemon\.[0-9a-f]{10}$/),
    expect.stringMatching(/^ace-next-[0-9a-f]{10}\.service$/),
  ]);
  // The same home always has the same name; another home has a different one.
  expect(names("/home/a/.ace/dev/")).toEqual(dev);
  expect(names("/var/tmp/other")).not.toEqual(dev);

  expect(windowsSpadeName("C:\\Users\\a\\dev")).toMatch(/^\\ace-next-spade-[0-9a-f]{10}$/);
  // Windows paths are one folder whatever their case.
  expect(windowsSpadeName("C:\\USERS\\A\\DEV")).toBe(windowsSpadeName("C:\\Users\\a\\dev"));
});

for (const platform of ["linux", "darwin"] as const)
  test(`${platform}: a second home installs its own Spade service and leaves the default home's alone`, async ({
    onTestFinished,
  }) => {
    const { user, main, dev } = await machine(onTestFinished);
    const manager = serviceManager(user);
    const mainPlan = spadePlanBesideShared(main, platform, account(user), undefined);
    await withSpadeBinary(main);
    expect(await installSpadeService(mainPlan, manager.ports)).toBe("running");

    const devPlan = spadePlanBesideShared(dev, platform, account(user), undefined);
    await withSpadeBinary(dev);
    expect(await installSpadeService(devPlan, manager.ports)).toBe("running");
    expect(devPlan.file).not.toBe(mainPlan.file);
    expect(await readFile(devPlan.file, "utf8")).toContain(dev);
    expect(await readFile(mainPlan.file, "utf8")).toBe(mainPlan.content);

    // Removing the dev home's Spade cleans up its own unit and nothing else.
    const before = manager.changes.length;
    expect(await removeSpadeService(devPlan, manager.ports)).toBe("absent");
    expect(existsSync(devPlan.file)).toBe(false);
    expect(
      manager.changes.slice(before).every((change) => change.endsWith(serviceName(devPlan))),
    ).toBe(true);
    expect(await readFile(mainPlan.file, "utf8")).toBe(mainPlan.content);
    expect(await spadeServiceState(mainPlan, manager.ports)).toBe("running");
  });

for (const platform of ["linux", "darwin"] as const)
  test(`${platform}: installing never replaces a Spade service that runs another home`, async ({
    onTestFinished,
  }) => {
    const { user, main, dev } = await machine(onTestFinished);
    const manager = serviceManager(user);
    // What a dev home wrote under the default name before services had per-home names.
    const stolen = spadeServicePlan(dev, platform, { ...account(user), sharedNameHome: dev });
    await mkdir(dirname(stolen.file), { recursive: true });
    await writeFile(stolen.file, stolen.content);

    const mainPlan = spadePlanBesideShared(main, platform, account(user), undefined);
    expect(mainPlan.file).toBe(stolen.file);
    await withSpadeBinary(main);
    for (const action of [installSpadeService, removeSpadeService, spadeServiceState])
      await expect(action(mainPlan, manager.ports)).rejects.toThrow(
        `runs another ace home, ${dev}, not ${main}`,
      );
    expect(manager.changes).toEqual([]);
    expect(await readFile(stolen.file, "utf8")).toBe(stolen.content);
  });

test("a home registered under the default name before per-home names keeps it, and its removal clears it", async ({
  onTestFinished,
}) => {
  const { user, main, dev } = await machine(onTestFinished);
  const manager = serviceManager(user);
  const earlier = spadeServicePlan(dev, "linux", { ...account(user), sharedNameHome: dev });
  await withSpadeBinary(dev);
  await installSpadeService(earlier, manager.ports);

  // An update or restart from that home finds the service it already has.
  const devPlan = spadePlanBesideShared(dev, "linux", account(user), undefined);
  expect(devPlan.file).toBe(earlier.file);
  expect(await spadeServiceState(devPlan, manager.ports)).toBe("running");
  // Turning its Spade off frees the default name for the default home.
  expect(await removeSpadeService(devPlan, manager.ports)).toBe("absent");
  const mainPlan = spadePlanBesideShared(main, "linux", account(user), undefined);
  await withSpadeBinary(main);
  expect(await installSpadeService(mainPlan, manager.ports)).toBe("running");
});

test("a Windows task that runs another home's Spade launcher is recognised as that home's", () => {
  const owner = { userHome: "C:\\Users\\a", sid: "S-1-5-21-1-2-3-1001", systemRoot: "C:\\Windows" };
  const other = spadeServicePlan("D:\\ace & co\\dev", "win32", {
    ...owner,
    sharedNameHome: "D:\\ace & co\\dev",
  });
  expect(registeredSpadeHome("win32", other.content)).toBe("D:\\ace & co\\dev");
});

function daemonPlan(user: string, home: string, sharedNameHome?: string): ServicePlan {
  return planService({
    platform: "linux",
    home: user,
    dataDir: home,
    executable: join(home, "bin/ace"),
    path: "/bin",
    uid: 501,
    sharedNameHome,
  });
}

test("a second home installs its own daemon service and leaves the default home's alone", async ({
  onTestFinished,
}) => {
  const { user, main, dev } = await machine(onTestFinished);
  const manager = serviceManager(user);
  const mainPlan = daemonPlan(user, main);
  await new UserService(mainPlan, manager.run).perform("install");
  const devPlan = daemonPlan(user, dev);
  await expect(new UserService(devPlan, manager.run).perform("install")).resolves.toEqual({
    active: true,
  });
  expect(devPlan.file).not.toBe(mainPlan.file);
  await expect(new UserService(devPlan, manager.run).perform("uninstall")).resolves.toEqual({
    active: false,
  });
  expect(existsSync(devPlan.file)).toBe(false);
  expect(await readFile(mainPlan.file, "utf8")).toBe(mainPlan.content);
  await expect(new UserService(mainPlan, manager.run).perform("status")).resolves.toEqual({
    active: true,
  });
});

test("installing never replaces a daemon service that runs another home", async ({
  onTestFinished,
}) => {
  const { user, main, dev } = await machine(onTestFinished);
  const manager = serviceManager(user);
  const stolen = daemonPlan(user, dev, dev);
  await mkdir(dirname(stolen.file), { recursive: true });
  await writeFile(stolen.file, stolen.content);
  const mainPlan = daemonPlan(user, main);
  expect(mainPlan.file).toBe(stolen.file);
  for (const action of ["install", "uninstall", "start", "status"] as const)
    await expect(new UserService(mainPlan, manager.run).perform(action)).rejects.toThrow(
      `runs another ace home, ${dev}, not ${main}`,
    );
  expect(manager.changes).toEqual([]);
  expect(await readFile(stolen.file, "utf8")).toBe(stolen.content);
});
