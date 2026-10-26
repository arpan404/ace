import { execFileSync } from "node:child_process";
import { chmod, copyFile, cp, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * The Linux tar.gz, built here rather than by electron-builder: its `ace-desktop` is a launcher
 * (`build/linux/launcher.sh`) and Electron is `ace-desktop-bin`. An extracted tarball has no
 * AppRun and no installer, so on Ubuntu 23.10+ Electron alone would abort before the app can
 * offer its sandbox setup; the launcher starts it without the sandbox there instead.
 *
 * It is made from electron-builder's unpacked app after its fuses are flipped, so it holds the
 * same bytes as the AppImage and deb. The top folder is `ace-<version>-<arch>`, as before.
 */
export async function writeLinuxTarball(options: {
  /** electron-builder's `linux-unpacked` or `linux-arm64-unpacked`. */
  unpacked: string;
  launcher: string;
  /** The app's 512 px icon: the tarball's app-list entry uses it (`os/appimage-entry.ts`). */
  icon: string;
  output: string;
  version: string;
  arch: "arm64" | "x64";
  /** Seconds since the epoch for every entry (SOURCE_DATE_EPOCH), so builds repeat. */
  mtime: number;
}): Promise<string> {
  const name = `ace-${options.version}-${options.arch}`;
  const staging = await mkdtemp(join(options.output, ".tarball-"));
  try {
    const top = join(staging, name);
    await cp(options.unpacked, top, { recursive: true, verbatimSymlinks: true });
    await rename(join(top, "ace-desktop"), join(top, "ace-desktop-bin"));
    await copyFile(options.launcher, join(top, "ace-desktop"));
    await chmod(join(top, "ace-desktop"), 0o755);
    await copyFile(options.icon, join(top, "ace-desktop.png"));
    const archive = join(options.output, `${name}.tar.gz`);
    await rm(archive, { force: true });
    execFileSync(
      "tar",
      [
        "--sort=name",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        `--mtime=@${options.mtime}`,
        "-I",
        "gzip -n -9",
        "-cf",
        archive,
        "-C",
        staging,
        name,
      ],
      { stdio: "inherit" },
    );
    return archive;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
