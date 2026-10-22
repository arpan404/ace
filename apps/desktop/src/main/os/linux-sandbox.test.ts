import { chromiumAppArmorProfile } from "@ace/browser/linux-sandbox";
import { expect, test } from "vitest";
import type { SandboxNotice } from "../../shared/contract.ts";
import { relaunchCommand, linuxInstall } from "./linux-sandbox.ts";
import { LinuxSandboxSetup, readSandboxFacts, type ElevatedRun } from "./linux-sandbox-setup.ts";

const restricted = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
const appImage = { APPIMAGE: "/home/me/Apps/ace-1.0.0-x64.AppImage" };

/** One launch of the app on a machine described by `files` (path → text). */
function launch(options: {
  env?: Record<string, string>;
  execPath?: string;
  noSandbox?: boolean;
  files?: Record<string, string>;
  dataDir?: string | null;
  elevation?: "pkexec" | "run0" | null;
  run?: ElevatedRun;
}) {
  const reported: SandboxNotice[] = [];
  const ran: string[][] = [];
  const setup = new LinuxSandboxSetup({
    facts: readSandboxFacts({
      env: options.env ?? appImage,
      execPath: options.execPath ?? "/tmp/.mount_ace-1abc/ace-desktop",
      noSandbox: options.noSandbox ?? true,
      uid: 1000,
      home: "/home/me",
      dataDir: options.dataDir === null ? undefined : (options.dataDir ?? "/home/me/.ace"),
      readText: (path) => (options.files ?? { [restricted]: "1\n" })[path],
    }),
    elevation:
      options.elevation === null
        ? undefined
        : {
            kind: options.elevation ?? "pkexec",
            path: `/usr/bin/${options.elevation ?? "pkexec"}`,
          },
    run: async (elevation, args) => {
      ran.push(args);
      return options.run ? options.run(elevation, args) : 0;
    },
    report: (notice) => reported.push(notice),
    log: () => {},
  });
  return { setup, reported, ran };
}
/** The profile names a setup run installed. */
const names = (args: string[]) => args.filter((_arg, index) => index % 2 === 0);

test("an AppImage started without its sandbox under the AppArmor restriction offers the setup", () => {
  const { setup } = launch({});
  const notice = setup.current();
  expect(notice.state).toBe("offer");
  expect(notice.state !== "hidden" && notice.sentence).toMatch(/AppArmor.*web pages in ace/);
});

test("nothing is offered where AppArmor does not restrict user namespaces", () => {
  const { setup } = launch({ files: { [restricted]: "0\n" } });
  expect(setup.current()).toEqual({ state: "hidden" });
});

test("a deb whose profiles are installed shows nothing, though the restriction is on", () => {
  // What the deb's postinst copies to /etc/apparmor.d/ace-chromium (scripts/package.ts).
  const profile = chromiumAppArmorProfile();
  const { setup } = launch({
    env: {},
    execPath: "/opt/ace/ace-desktop",
    noSandbox: false,
    files: { [restricted]: "1", "/etc/apparmor.d/ace-chromium": profile },
  });
  expect(setup.current()).toEqual({ state: "hidden" });
});

test("a sandboxed app still offers the setup when ace's headless Chrome has no profile", async () => {
  const { setup, ran } = launch({ env: {}, execPath: "/opt/ace/ace-desktop", noSandbox: false });
  const notice = setup.current();
  expect(notice.state !== "hidden" && notice.sentence).toMatch(/headless browser/);
  // Chrome's profile alone needs no restart: Chrome starts fresh for every browser session.
  expect(await setup.setup()).toEqual({ state: "hidden" });
  expect(names(ran[0] ?? [])).toEqual(["ace-chromium"]);
});

test("after the person approves, the app asks for a restart to turn its sandbox on", async () => {
  const { setup, reported, ran } = launch({});
  const done = await setup.setup();
  expect(done).toEqual({
    state: "restart",
    sentence: "The sandbox is set up; restart ace to turn it on.",
  });
  expect(reported.map((notice) => notice.state)).toEqual(["working", "restart"]);
  expect(names(ran[0] ?? [])).toEqual(["ace-desktop-user-1000", "ace-chromium"]);
});

test("dismissing the password prompt leaves the offer as it was", async () => {
  const { setup } = launch({ run: async () => 126 });
  const before = setup.current();
  expect(await setup.setup()).toEqual(before);
});

test("a failed setup hands the person the same setup as terminal commands", async () => {
  const { setup } = launch({ elevation: "run0", run: async () => 1 });
  const notice = await setup.setup();
  expect(notice.state).toBe("commands");
  const commands = notice.state === "commands" ? notice.commands : "";
  expect(commands).toContain("sudo tee /etc/apparmor.d/ace-desktop-user-1000 >/dev/null <<'EOF'");
  expect(commands).toContain("/home/me/Apps/{ace-1.0.0-x64.AppImage,ace-*.AppImage}");
  expect(commands).toContain("sudo apparmor_parser -r /etc/apparmor.d/ace-chromium");
});

test("without pkexec or run0 the setup is offered as commands to copy", async () => {
  const { setup, ran } = launch({ elevation: null });
  expect((await setup.setup()).state).toBe("commands");
  expect(ran).toEqual([]);
});

test("a second press while the prompt is open does not open another prompt", async () => {
  let answer: ((code: number) => void) | undefined;
  const { setup, ran } = launch({ run: () => new Promise((done) => (answer = done)) });
  const first = setup.setup();
  const second = setup.setup();
  await Promise.resolve();
  answer?.(0);
  expect(await second).toEqual(await first);
  expect(ran).toHaveLength(1);
});

test("a remote daemon or an opted-out sandbox leaves ace's Chrome out of the setup", async () => {
  for (const options of [
    { dataDir: null },
    { env: { ...appImage, ACE_CHROMIUM_NO_SANDBOX: "1" } },
  ] as const) {
    const { setup, ran } = launch(options);
    await setup.setup();
    expect(names(ran[0] ?? [])).toEqual(["ace-desktop-user-1000"]);
  }
});

test("a tar.gz's profile covers its launcher and Electron, so either start is sandboxed", async () => {
  const { setup, ran } = launch({ env: {}, execPath: "/home/me/ace-1.0.0-x64/ace-desktop-bin" });
  await setup.setup();
  expect(ran[0]?.[1]).toContain(
    "profile ace-desktop-user-1000 /home/me/ace-1.0.0-x64/ace-desktop{,-bin} flags=(unconfined)",
  );
});

test("Restart starts the AppImage file or the tar.gz launcher again, with the sandbox", () => {
  const argv = ["/tmp/.mount_x/ace-desktop", "--no-sandbox", "ace://t/1"];
  expect(relaunchCommand(linuxInstall(appImage, argv[0] ?? ""), argv)).toEqual({
    execPath: "/home/me/Apps/ace-1.0.0-x64.AppImage",
    args: ["ace://t/1"],
  });
  const tar = linuxInstall({}, "/home/me/ace/ace-desktop-bin");
  expect(relaunchCommand(tar, ["/home/me/ace/ace-desktop-bin", "--no-sandbox"])).toEqual({
    execPath: "/home/me/ace/ace-desktop",
    args: [],
  });
  expect(relaunchCommand(linuxInstall({}, "/opt/ace/ace-desktop"), argv)).toBeUndefined();
});
