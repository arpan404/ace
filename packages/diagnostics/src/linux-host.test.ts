import { expect, it } from "vitest";
import { runDoctor, type CheckResult } from "./index.ts";
import { linuxHostChecks, type LinuxHost } from "./linux-host.ts";

/** A Linux machine described by its files: path → text, with read/write access by path. */
function machine(options: {
  files?: Record<string, string>;
  writable?: string[];
  path?: Record<string, string>;
  env?: Record<string, string>;
}): LinuxHost {
  const files = options.files ?? {};
  return {
    env: { HOME: "/home/me", ...options.env },
    readText: async (path) => files[path],
    exists: async (path) =>
      Object.keys(files).some((file) => file === path || file.startsWith(`${path}/`)),
    readWrite: async (path) => (options.writable ?? []).includes(path),
    which: async (name) => options.path?.[name],
  };
}

async function checks(host: LinuxHost): Promise<Record<string, CheckResult>> {
  const report = await runDoctor(linuxHostChecks(host), { now: () => 1 });
  return Object.fromEntries(report.checks.map((check) => [check.id, check]));
}

const watches = (limit: string) => ({ "/proc/sys/fs/inotify/max_user_watches": `${limit}\n` });

it("a well-set-up Linux desktop passes every Linux check", async () => {
  const result = await checks(
    machine({
      files: {
        ...watches("524288"),
        "/run/user/1000/systemd/private": "",
        "/home/me/Android/Sdk/emulator/emulator": "",
        "/dev/kvm": "",
      },
      writable: ["/dev/kvm"],
      path: { "xdg-open": "/usr/bin/xdg-open" },
      env: { XDG_RUNTIME_DIR: "/run/user/1000" },
    }),
  );
  expect(Object.values(result).map((check) => [check.id, check.status])).toEqual([
    ["linux.inotify", "ok"],
    ["linux.xdg-open", "ok"],
    ["linux.systemd-user", "ok"],
    ["linux.kvm", "ok"],
  ]);
  expect(result["linux.kvm"]?.message).toContain("usable");
});

it("a low inotify watch limit warns with the sysctl that raises it", async () => {
  const result = await checks(machine({ files: watches("8192") }));
  expect(result["linux.inotify"]).toMatchObject({
    status: "warn",
    message: "inotify watch limit: 8192",
    fix: expect.stringContaining("fs.inotify.max_user_watches"),
  });
});

it("a machine without xdg-open or a systemd user session warns about both", async () => {
  const result = await checks(machine({ files: watches("524288") }));
  expect(result["linux.xdg-open"]).toMatchObject({
    status: "warn",
    fix: expect.stringContaining("xdg-utils"),
  });
  expect(result["linux.systemd-user"]).toMatchObject({
    status: "warn",
    fix: expect.stringContaining("enable-linger"),
  });
});

it("an Android SDK in ~/Android/Sdk without /dev/kvm access gets the kvm group hint", async () => {
  const result = await checks(
    machine({ files: { "/home/me/Android/Sdk/emulator/emulator": "", "/dev/kvm": "" } }),
  );
  expect(result["linux.kvm"]).toMatchObject({
    status: "warn",
    message: expect.stringContaining("No access to /dev/kvm"),
    fix: expect.stringContaining("usermod -aG kvm"),
  });
});

it("an Android SDK on a machine with no /dev/kvm points at firmware virtualization", async () => {
  const result = await checks(
    machine({
      files: { "/opt/android/emulator/emulator": "" },
      env: { ANDROID_HOME: "/opt/android" },
    }),
  );
  expect(result["linux.kvm"]).toMatchObject({
    status: "warn",
    message: expect.stringContaining("/dev/kvm is missing"),
  });
});

it("without an Android SDK, /dev/kvm access is not asked for", async () => {
  const result = await checks(machine({ files: { "/dev/kvm": "" } }));
  expect(result["linux.kvm"]?.status).toBe("ok");
});
