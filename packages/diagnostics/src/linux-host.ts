import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { androidSdkRoots } from "@ace/devices/sdk-roots";
import { findExecutable } from "@ace/provider-kit/discovery";
import type { Check, Verdict } from "./doctor.ts";

/** What the Linux checks read from the machine; the real one is `linuxHost`. */
export interface LinuxHost {
  env: Readonly<Record<string, string | undefined>>;
  /** The CPU architecture, as `process.arch` names it. */
  arch: string;
  /** A small file's text, or undefined when it can't be read. */
  readText(path: string): Promise<string | undefined>;
  exists(path: string): Promise<boolean>;
  /** The current user may read and write `path`. */
  readWrite(path: string): Promise<boolean>;
  /** The executable's path on `env.PATH`, if any. */
  which(name: string): Promise<string | undefined>;
}

/** Below this, a large workspace can run out of inotify watches. */
export const minimumInotifyWatches = 65_536;

const inotifyFix =
  "Raise the limit: echo fs.inotify.max_user_watches=524288 | sudo tee /etc/sysctl.d/90-ace.conf && sudo sysctl --system";
const xdgOpenFix = "Install xdg-utils with your package manager.";
const systemdFix =
  "Run ace from a systemd login session, or run `loginctl enable-linger $USER` so the user service manager starts.";
const kvmFix =
  "Add yourself to the kvm group: sudo usermod -aG kvm $USER, then sign out and back in. If /dev/kvm is missing, enable virtualization (VT-x/AMD-V) in firmware.";

const noArmEmulatorFix =
  "Use Android devices from a Mac or an x86-64 Linux machine; Linux on arm64 can't run them.";

const verdict = (status: Verdict["status"], message: string, fix: string): Verdict => ({
  status,
  message,
  fix,
});

/**
 * Linux-only doctor checks: the inotify watch budget (workspace watching), `xdg-open` (opening
 * links and sign-in pages), a systemd user session (the background service), and `/dev/kvm`
 * access when an Android SDK is installed (hardware-accelerated emulators). Each reads a few
 * small files or PATH entries, so all stay well inside the doctor's per-check timeout.
 */
export function linuxHostChecks(host: LinuxHost): Check[] {
  return [
    {
      id: "linux.inotify",
      fix: inotifyFix,
      run: async () => {
        const text = await host.readText("/proc/sys/fs/inotify/max_user_watches");
        const limit = text === undefined ? NaN : Number.parseInt(text.trim(), 10);
        if (!Number.isFinite(limit))
          return verdict("warn", "inotify watch limit could not be read", inotifyFix);
        return verdict(
          limit < minimumInotifyWatches ? "warn" : "ok",
          `inotify watch limit: ${limit}`,
          inotifyFix,
        );
      },
    },
    {
      id: "linux.xdg-open",
      fix: xdgOpenFix,
      run: async () => {
        const found = await host.which("xdg-open");
        return verdict(
          found ? "ok" : "warn",
          found ? `xdg-open at ${found}` : "xdg-open not found; links and sign-in pages won't open",
          xdgOpenFix,
        );
      },
    },
    {
      id: "linux.systemd-user",
      fix: systemdFix,
      run: async () => {
        const runtime = host.env.XDG_RUNTIME_DIR;
        // The user manager listens on this socket whenever it runs for the session.
        const running = runtime ? await host.exists(join(runtime, "systemd", "private")) : false;
        return verdict(
          running ? "ok" : "warn",
          running
            ? "systemd user session available"
            : "No systemd user session; the background service can't be installed",
          systemdFix,
        );
      },
    },
    {
      id: "linux.kvm",
      fix: kvmFix,
      run: async () => {
        const sdk = await installedSdk(host);
        if (!sdk) return verdict("ok", "Android SDK not installed; /dev/kvm not needed", kvmFix);
        // Google's SDK repository has the emulator and platform-tools for x86-64 Linux only.
        if (host.arch === "arm64")
          return verdict(
            "warn",
            "Android emulators can't run here: Google publishes the Android Emulator and Platform Tools for x86-64 Linux only",
            noArmEmulatorFix,
          );
        if (!sdk.emulator)
          return verdict(
            "ok",
            "No Android Emulator in the Android SDK; /dev/kvm not needed",
            kvmFix,
          );
        if (!(await host.exists("/dev/kvm")))
          return verdict("warn", "/dev/kvm is missing; Android emulators run slowly", kvmFix);
        const usable = await host.readWrite("/dev/kvm");
        return verdict(
          usable ? "ok" : "warn",
          usable
            ? "/dev/kvm is usable for Android emulators"
            : "No access to /dev/kvm; Android emulators can't use hardware acceleration",
          kvmFix,
        );
      },
    },
  ];
}

/** The first Android SDK folder present, and whether it has the emulator. */
async function installedSdk(
  host: LinuxHost,
): Promise<{ root: string; emulator: boolean } | undefined> {
  let found: { root: string; emulator: boolean } | undefined;
  for (const root of androidSdkRoots(host.env, host.env.HOME)) {
    if (await host.exists(join(root, "emulator"))) return { root, emulator: true };
    if (!found && (await host.exists(root))) found = { root, emulator: false };
  }
  return found;
}

/** `LinuxHost` on the real machine. */
export function linuxHost(env: NodeJS.ProcessEnv, arch: string): LinuxHost {
  return {
    env,
    arch,
    readText: async (path) => {
      try {
        return (await readFile(path, "utf8")).slice(0, 4096);
      } catch {
        return undefined;
      }
    },
    exists: async (path) => {
      try {
        await access(path, constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    readWrite: async (path) => {
      try {
        await access(path, constants.R_OK | constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    which: (name) => findExecutable(name, env),
  };
}
