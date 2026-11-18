import { existsSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { canonicalPath } from "./canonical-path.ts";
import { localServicePlan } from "./local.ts";
import { planService, type ServiceConfig } from "./plan.ts";
import { UserService } from "./service.ts";
import { spadeServicePlan } from "./spade-plan.ts";
import { spadePlanFor, spadeServiceName } from "./spade-local.ts";
import {
  installSpadeService,
  removeSpadeService,
  restartSpadeService,
  spadeServiceState,
} from "./spade-service.ts";
import { machine, serviceManager, withSpadeBinary } from "./service-test-support.ts";

/**
 * Which service is a home's own (ADR 0185) when its path needs escaping in a plist or unit, or
 * when one folder has two spellings.
 */

const account = (user: string) => ({ userHome: user, uid: 501 });
const io = { canonical: canonicalPath, loadedTask: () => undefined };

const daemonConfig = (platform: "darwin" | "linux", user: string, home: string): ServiceConfig => ({
  platform,
  home: user,
  dataDir: home,
  executable: join(home, "bin/ace"),
  path: "/bin",
  uid: 501,
});

/** A path every registration format escapes: XML entities, systemd specifiers and `$`. */
const awkward = "ace & co <100%> $HOME";

for (const platform of ["linux", "darwin"] as const)
  test(`${platform}: a custom home with an escaped path keeps its default-name daemon service, and stop and removal reach it`, async ({
    onTestFinished,
  }) => {
    const { user } = await machine(onTestFinished);
    const home = join(user, awkward);
    await mkdir(home);
    const manager = serviceManager(user);
    // What a build from before per-home names registered for this custom home.
    const earlier = planService({ ...daemonConfig(platform, user, home), serviceTag: "" });
    await new UserService(earlier, manager.run).perform("install");

    const plan = localServicePlan(daemonConfig(platform, user, home), canonicalPath);
    expect(plan.file).toBe(earlier.file);
    expect(plan.content).toBe(earlier.content);
    const service = new UserService(plan, manager.run);
    await expect(service.perform("stop")).resolves.toEqual({ active: false });
    await expect(service.perform("uninstall")).resolves.toEqual({ active: false });
    expect(existsSync(earlier.file)).toBe(false);
    expect(manager.changes.every((change) => change.endsWith(earlier.domain))).toBe(true);
  });

for (const platform of ["linux", "darwin"] as const)
  test(`${platform}: a custom home with an escaped path keeps its default-name Spade service, and restart and removal reach it`, async ({
    onTestFinished,
  }) => {
    const { user } = await machine(onTestFinished);
    const home = join(user, awkward);
    await mkdir(home);
    const manager = serviceManager(user);
    const earlier = spadeServicePlan(home, platform, { ...account(user), serviceTag: "" });
    await withSpadeBinary(home);
    await installSpadeService(earlier, manager.ports);

    const plan = spadePlanFor(home, platform, account(user), io);
    expect(plan.file).toBe(earlier.file);
    await restartSpadeService(plan, manager.ports);
    expect(await spadeServiceState(plan, manager.ports)).toBe("running");
    expect(await removeSpadeService(plan, manager.ports)).toBe("absent");
    expect(existsSync(earlier.file)).toBe(false);
  });

test("a home refuses to choose its own name while the service under the default name can't be read as ace's", async ({
  onTestFinished,
}) => {
  const { user, dev } = await machine(onTestFinished);
  const shared = spadeServicePlan(join(user, ".ace"), "linux", account(user));
  const daemon = planService(daemonConfig("linux", user, join(user, ".ace")));
  for (const file of [shared.file, daemon.file]) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "[Service]\nExecStart=/somewhere/else\n");
  }
  expect(() => spadePlanFor(dev, "linux", account(user), io)).toThrow(
    /Can't tell which ace home the service ace-next-spade.service runs/,
  );
  expect(() => localServicePlan(daemonConfig("linux", user, dev), canonicalPath)).toThrow(
    /Can't tell which ace home the service ace-next.service runs/,
  );
  expect(await readFile(shared.file, "utf8")).toBe("[Service]\nExecStart=/somewhere/else\n");
});

for (const platform of ["linux", "darwin"] as const)
  for (const [installed, later] of [
    ["link", "real"],
    ["real", "link"],
  ] as const)
    test(`${platform}: a Spade service installed through the home's ${installed} path is restarted and removed through its ${later} path`, async ({
      onTestFinished,
    }) => {
      const { user } = await machine(onTestFinished);
      const paths = { real: join(user, "real-home"), link: join(user, "home-link") };
      await mkdir(paths.real);
      await symlink(paths.real, paths.link);
      const manager = serviceManager(user);
      const first = spadePlanFor(paths[installed], platform, account(user), io);
      await withSpadeBinary(paths.real);
      expect(await installSpadeService(first, manager.ports)).toBe("running");

      const second = spadePlanFor(paths[later], platform, account(user), io);
      expect(spadeServiceName(second)).toBe(spadeServiceName(first));
      await restartSpadeService(second, manager.ports);
      expect(await spadeServiceState(second, manager.ports)).toBe("running");
      expect(await removeSpadeService(second, manager.ports)).toBe("absent");
      expect(existsSync(first.file)).toBe(false);
    });

test("a daemon service installed through a link to its home is stopped and removed through the real path", async ({
  onTestFinished,
}) => {
  const { user } = await machine(onTestFinished);
  const real = join(user, "real-home");
  const link = join(user, "home-link");
  await mkdir(real);
  await symlink(real, link);
  const manager = serviceManager(user);
  const first = localServicePlan(daemonConfig("linux", user, link), canonicalPath);
  await new UserService(first, manager.run).perform("install");
  const second = localServicePlan(daemonConfig("linux", user, real), canonicalPath);
  expect(second.domain).toBe(first.domain);
  await expect(new UserService(second, manager.run).perform("uninstall")).resolves.toEqual({
    active: false,
  });
  expect(existsSync(first.file)).toBe(false);
});

test("the default home reached through a link keeps the default names", async ({
  onTestFinished,
}) => {
  const { user, main } = await machine(onTestFinished);
  const userLink = `${user}-link`;
  await symlink(user, userLink);
  onTestFinished(() => rm(userLink, { force: true }));
  const viaLink = spadePlanFor(join(userLink, ".ace"), "linux", account(user), io);
  const linkedUser = spadePlanFor(main, "linux", account(userLink), io);
  expect([spadeServiceName(viaLink), spadeServiceName(linkedUser)]).toEqual([
    "ace-next-spade.service",
    "ace-next-spade.service",
  ]);
  expect(
    localServicePlan(daemonConfig("linux", user, join(userLink, ".ace")), canonicalPath).domain,
  ).toBe("ace-next.service");
});

test("on a case-insensitive volume, two cases of a home's name are one Spade service", async ({
  onTestFinished,
}) => {
  const { user } = await machine(onTestFinished);
  const stored = join(user, "Dev-Home");
  await mkdir(stored);
  // The volume folds case: every spelling of a name is the one it stores.
  const folding = {
    canonical: (path: string) => canonicalPath(path).toLowerCase(),
    loadedTask: () => undefined,
  };
  const manager = serviceManager(user);
  const first = spadePlanFor(stored, "darwin", account(user), folding);
  await withSpadeBinary(stored);
  await installSpadeService(first, manager.ports);
  const second = spadePlanFor(join(user, "dev-home"), "darwin", account(user), folding);
  expect(spadeServiceName(second)).toBe(spadeServiceName(first));
  expect(await removeSpadeService(second, manager.ports)).toBe("absent");
  expect(existsSync(first.file)).toBe(false);
});
