import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { Toolchain } from "@ace/protocol";
import type { DoctorContext } from "./feature.ts";
import { installFeature, type InstallPorts } from "./install.ts";
import { doctorTestContext } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function ports(overrides: Partial<InstallPorts> = {}): InstallPorts {
  return {
    cliEntry: undefined,
    desktopApps: () => [],
    daemonVersion: async () => undefined,
    toolchains: async () => [],
    ...overrides,
  };
}

async function setup(overrides: Partial<DoctorContext> = {}) {
  const made = await doctorTestContext(overrides);
  cleanups.push(made.cleanup);
  return { ...made, root: made.context.home };
}

async function run(context: DoctorContext, installPorts: InstallPorts, id: string) {
  const check = installFeature(installPorts)
    .checks(context)
    .find((candidate) => candidate.id === id);
  if (!check) throw new Error(`missing check ${id}`);
  return check.run(new AbortController().signal);
}

async function desktopApp(root: string, version: string): Promise<string> {
  const bundle = join(root, "Applications", "ace.app");
  await mkdir(join(bundle, "Contents"), { recursive: true });
  await writeFile(
    join(bundle, "Contents", "Info.plist"),
    `<?xml version="1.0"?><plist version="1.0"><dict>
  <key>CFBundleIdentifier</key>
  <string>dev.ace.app</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
</dict></plist>`,
  );
  return bundle;
}

it("a CLI newer than the running daemon warns and says to restart the daemon", async () => {
  const { context } = await setup({ env: { ACE_VERSION: "0.0.4" }, daemonState: "running" });
  const verdict = await run(
    context,
    ports({ daemonVersion: async () => "0.0.2" }),
    "install.versions",
  );
  expect(verdict.status).toBe("warn");
  expect(verdict.message).toContain("The running daemon is older than 0.0.4");
  expect(verdict.fix).toContain("Restart the daemon");
});

it("an outdated desktop app is named as the side to update", async () => {
  const { context, root } = await setup({ env: { ACE_VERSION: "0.1.0" }, platform: "darwin" });
  const bundle = await desktopApp(root, "0.0.9");
  const verdict = await run(
    context,
    ports({ daemonVersion: async () => "0.1.0", desktopApps: () => [bundle] }),
    "install.versions",
  );
  expect(verdict.status).toBe("warn");
  expect(verdict.message).toContain(`The ace app (${bundle}) is older than 0.1.0`);
  expect(verdict.fix).toContain(`Update the ace app at ${bundle} to 0.1.0`);
});

it("the app's bundled CLI takes its version from the app, so it matches the app's daemon", async () => {
  const { context, root } = await setup({ env: {}, platform: "darwin" });
  const bundle = await desktopApp(root, "0.0.4");
  const verdict = await run(
    context,
    ports({
      cliEntry: join(bundle, "Contents", "Resources", "daemon", "ace.mjs"),
      daemonVersion: async () => "0.0.4",
      desktopApps: () => [bundle],
    }),
    "install.versions",
  );
  expect(verdict.status).toBe("ok");
  expect(verdict.message).toContain("This ace command 0.0.4");
  expect(verdict.message).toContain("the running daemon 0.0.4");
});

it("development builds pass against each other and against a release", async () => {
  const { context } = await setup({ env: { ACE_VERSION: "development" } });
  for (const daemon of ["development", "0.0.2"]) {
    const verdict = await run(
      context,
      ports({ daemonVersion: async () => daemon }),
      "install.versions",
    );
    expect(verdict.status).toBe("ok");
  }
});

it("a stopped daemon leaves versions ok and says it isn't running", async () => {
  const { context } = await setup({ env: { ACE_VERSION: "0.0.4" } });
  const verdict = await run(context, ports(), "install.versions");
  expect(verdict).toMatchObject({ status: "ok" });
  expect(verdict.message).toContain("the daemon isn't running");
});

it("data written by a newer ace fails and says to update ace", async () => {
  const { context, dataDir } = await setup();
  await writeFile(
    join(dataDir, "ace-format.json"),
    JSON.stringify({ format: "ace-v99", createdAt: "2026-01-01T00:00:00.000Z" }),
  );
  const verdict = await run(context, ports(), "install.data-format");
  expect(verdict.status).toBe("fail");
  expect(verdict.message).toContain("ace-v99");
  expect(verdict.fix).toContain("Update ace");
});

it("data in this build's format passes and names the format, without writing anything", async () => {
  const { context, dataDir } = await setup();
  const fresh = await run(context, ports(), "install.data-format");
  expect(fresh.status).toBe("ok");
  expect(await readdir(dataDir)).toEqual([]);
  await writeFile(
    join(dataDir, "ace-format.json"),
    JSON.stringify({ format: "ace-v1", createdAt: "2026-01-01T00:00:00.000Z" }),
  );
  const current = await run(context, ports(), "install.data-format");
  expect(current.status).toBe("ok");
  expect(current.message).toContain("ace-v1");
});

async function executable(directory: string, content: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, "ace");
  await writeFile(path, content);
  await chmod(path, 0o755);
  return path;
}

it.skipIf(process.platform === "win32")(
  "two different ace installations on PATH warn and name the one that wins",
  async () => {
    const { root } = await setup();
    const first = await executable(
      join(root, "one"),
      "#!/bin/sh\n# ace-cli-shim: written by the ace desktop app on launch\nexec '/Applications/ace.app/Contents/Resources/runtime/bin/node' --disable-warning=ExperimentalWarning '/Applications/ace.app/Contents/Resources/daemon/ace.mjs' \"$@\"\n",
    );
    const second = await executable(join(root, "two"), "#!/bin/sh\necho old ace\n");
    const { context } = await setup({
      env: { PATH: [join(root, "one"), join(root, "two")].join(":") },
    });
    const verdict = await run(context, ports(), "install.cli-path");
    expect(verdict.status).toBe("warn");
    expect(verdict.message).toContain(`${first} (runs /Applications/ace.app) wins`);
    expect(verdict.message).toContain(second);
  },
);

it.skipIf(process.platform === "win32")(
  "the same ace reached through two PATH entries passes",
  async () => {
    const { root } = await setup();
    const path = await executable(join(root, "bin"), "#!/bin/sh\necho ace\n");
    const { context } = await setup({
      env: { PATH: [join(root, "bin"), join(root, "bin")].join(":") },
    });
    const verdict = await run(context, ports(), "install.cli-path");
    expect(verdict.status).toBe("ok");
    expect(verdict.message).toContain(path);
  },
);

const toolchains = async (): Promise<Toolchain[]> => [
  { id: "git", available: true, detail: "git version 2.50.0", hint: "" },
  {
    id: "xcode",
    available: false,
    detail: "Simulator tools not found",
    hint: "Install Xcode from the App Store",
  },
  {
    id: "android",
    available: true,
    detail: "Android Debug Bridge version 1.0.41",
    hint: "",
    version: "35.0.2",
  },
];

it("a missing optional toolchain stays ok and carries its setup hint", async () => {
  const { context } = await setup({ platform: "darwin" });
  const xcode = await run(context, ports({ toolchains }), "install.xcode");
  expect(xcode).toEqual({
    status: "ok",
    message: "Xcode not installed; needed only for the iOS Simulator",
    fix: "Install Xcode from the App Store",
  });
  const android = await run(context, ports({ toolchains }), "install.android");
  expect(android.status).toBe("ok");
  expect(android.message).toContain("35.0.2");
  expect(
    installFeature(ports({ toolchains }))
      .checks(context)
      .some((check) => check.id === "install.git"),
  ).toBe(false);
});
