import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/*
 * An agent signing in opens its sign-in page with the system opener (`open`, `xdg-open`) or
 * `$BROWSER`. For the sign-in process only, ace puts a stand-in for both first on PATH: it
 * records the page instead of opening it, so ace can hand the page to the person's client (the
 * desktop app opens it, another device shows the link) or, for a page it can't relay, open it
 * here as the agent meant to. Anything else the agent opens goes to the real opener unchanged.
 */

const maxRecordedBytes = 256 * 1024;

const standIn = `#!/bin/sh
recorded=
for arg in "$@"; do
  case "$arg" in
    http://*|https://*) printf '%s\\n' "$arg" >> "$ACE_SIGN_IN_PAGES"; recorded=1 ;;
  esac
done
[ -n "$recorded" ] && exit 0
PATH="$ACE_SIGN_IN_PATH"; export PATH
if [ -n "$ACE_SIGN_IN_BROWSER" ]; then BROWSER="$ACE_SIGN_IN_BROWSER"; export BROWSER; else unset BROWSER; fi
if [ -n "$ACE_SIGN_IN_OPENER" ]; then exec "$ACE_SIGN_IN_OPENER" "$@"; fi
exit 0
`;

export interface SignInPages {
  /** The sign-in process's environment. */
  env: NodeJS.ProcessEnv;
  /** Pages the agent asked to open since the last call. */
  take(): Promise<string[]>;
  /** Open a page the way the agent meant to: the person's browser on this computer. */
  open(url: string): void;
  close(): Promise<void>;
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The opener the agent would have used: a plain `$BROWSER`, else the platform's own. */
export async function systemOpener(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  const browser = env.BROWSER;
  if (browser && /^[^\s%]+$/.test(browser)) return browser;
  if (platform === "darwin") return "/usr/bin/open";
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, "xdg-open");
    if (await executable(candidate)) return candidate;
  }
  return undefined;
}

function launch(opener: string | undefined, url: string, env: NodeJS.ProcessEnv): void {
  if (!opener) return;
  try {
    const child = spawn(opener, [url], { env, stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // A missing opener leaves the page unopened, as it would have been for the agent.
  }
}

export async function signInPages(
  base: NodeJS.ProcessEnv,
  options: { platform?: NodeJS.Platform; root?: string } = {},
): Promise<SignInPages> {
  const platform = options.platform ?? process.platform;
  const opener = await systemOpener(base, platform);
  if (platform === "win32")
    return {
      env: base,
      take: async () => [],
      open: (url) => launch(opener, url, base),
      close: async () => {},
    };
  const dir = await mkdtemp(join(options.root ?? tmpdir(), "ace-sign-in-"));
  const pages = join(dir, "pages");
  const command = join(dir, "open");
  await writeFile(pages, "", { mode: 0o600 });
  await writeFile(command, standIn, { mode: 0o700 });
  await writeFile(join(dir, "xdg-open"), standIn, { mode: 0o700 });
  // The process umask may narrow the mode; the stand-ins must stay executable.
  await chmod(command, 0o700);
  await chmod(join(dir, "xdg-open"), 0o700);
  let offset = 0;
  let partial = "";
  return {
    env: {
      ...base,
      PATH: base.PATH ? `${dir}${delimiter}${base.PATH}` : dir,
      BROWSER: command,
      ACE_SIGN_IN_PAGES: pages,
      ACE_SIGN_IN_PATH: base.PATH ?? "",
      ACE_SIGN_IN_BROWSER: base.BROWSER ?? "",
      ACE_SIGN_IN_OPENER: opener ?? "",
    },
    async take() {
      if (offset >= maxRecordedBytes) return [];
      const file = await open(pages, "r");
      try {
        const buffer = Buffer.alloc(maxRecordedBytes - offset);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
        offset += bytesRead;
        const lines = (partial + buffer.subarray(0, bytesRead).toString("utf8")).split("\n");
        partial = lines.pop() ?? "";
        return lines.map((line) => line.trim()).filter(Boolean);
      } finally {
        await file.close();
      }
    },
    open: (url) => launch(opener, url, base),
    close: () => rm(dir, { recursive: true, force: true }),
  };
}
