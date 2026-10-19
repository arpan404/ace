import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { boundedText, releaseFetch, type Fetcher } from "@ace/service";
import {
  desktopAppMarker,
  desktopExecutable,
  desktopUpdateArgument,
  DesktopApp,
  GithubRelease,
  newerDesktopRelease,
} from "@ace/service/desktop-update";

const releasesFeed = "https://api.github.com/repos/arpan404/ace/releases?per_page=30";

/**
 * The desktop app this CLI was bundled into, from the marker its build writes beside the
 * daemon bundle; undefined for a standalone release, which updates itself (ADR 0041).
 */
export async function bundledDesktopApp(
  directory: string,
): Promise<{ version: string; executable: string } | undefined> {
  const marker = join(directory, desktopAppMarker);
  if (!existsSync(marker)) return undefined;
  const app = DesktopApp.parse(JSON.parse(await readFile(marker, "utf8")));
  return { version: app.version, executable: desktopExecutable(directory, process.platform) };
}

/** The directory of the running daemon bundle (`ace.mjs`). */
export function daemonDirectory(entryUrl: string): string {
  return dirname(fileURLToPath(entryUrl));
}

export async function latestDesktopVersion(
  current: string,
  fetcher: Fetcher = releaseFetch,
): Promise<string | undefined> {
  const response = await fetcher(releasesFeed, {
    signal: AbortSignal.timeout(30_000),
    headers: { Accept: "application/vnd.github+json" },
  });
  const releases = z
    .array(GithubRelease)
    .max(100)
    .parse(JSON.parse(await boundedText(response, 4 * 1024 * 1024)));
  return newerDesktopRelease(releases, current);
}

/**
 * `ace update` from the CLI inside the desktop app. `check` reports the newest release;
 * `apply` asks the app to install it: the app downloads and verifies the update, waits for
 * running agents to finish, then restarts with its new daemon (ADR 0087). There is no
 * standalone transaction to `recover`.
 */
export async function desktopUpdateCli(
  command: "check" | "apply" | "recover",
  app: { version: string; executable: string },
  write: (line: string) => void,
  fetcher: Fetcher = releaseFetch,
): Promise<void> {
  if (command === "recover") {
    write("Nothing to recover: the ace app installs its own updates.");
    return;
  }
  const latest = await latestDesktopVersion(app.version, fetcher);
  if (!latest) {
    write(`ace ${app.version} is up to date.`);
    return;
  }
  if (command === "check") {
    write(
      `ace ${latest} is available (this is ${app.version}). Run \`ace update apply\` to install it.`,
    );
    return;
  }
  if (!existsSync(app.executable))
    throw new Error(`The ace app is not at ${app.executable}; open it and use Check for Updates.`);
  // A running app receives this as a second instance; otherwise the app starts with it.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(app.executable, [desktopUpdateArgument], { detached: true, stdio: "ignore", env }).unref();
  write(
    `Updating the ace app to ${latest}. It downloads the update, waits for running agents to finish, then restarts.`,
  );
}
