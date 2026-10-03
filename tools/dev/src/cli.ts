#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  daemonUrl,
  devLayout,
  profile,
  profileNames,
  usesDaemon,
  webUrl,
  type DevLayout,
} from "./profiles.ts";
import { ProcessGroup, runUntilInterrupted } from "./runner.ts";

/**
 * `bun run dev`, `dev:web`, `dev:fake`, `dev:desktop:fake` and `daemon`. Everything the
 * development daemon writes lives under `.ace-dev/`, never in `~/.ace`.
 */
const repo = resolve(import.meta.dirname, "../../..");
const layout = devLayout(repo, process.env);
mkdirSync(layout.home, { recursive: true, mode: 0o700 });
mkdirSync(layout.electron, { recursive: true });

if (process.argv[2] === "doctor") {
  // The daemon's own checks, against the development home and port.
  try {
    execFileSync(
      process.execPath,
      [join(repo, "apps/daemon/src/cli.ts"), "doctor", ...process.argv.slice(3)],
      {
        stdio: "inherit",
        env: { ...process.env, ACE_HOME: layout.home, ACE_PORT: String(layout.daemonPort) },
      },
    );
  } catch {
    process.exitCode = 1;
  }
  process.exit();
}
const name = z.enum(profileNames).parse(process.argv[2]);

if (usesDaemon(name) && process.env.ACE_DEV_SEED === "1") {
  // Seeding writes the store directly, so it runs before the daemon takes its lock.
  execFileSync(process.execPath, [join(repo, "tools/dev/src/seed.ts")], {
    stdio: "inherit",
    env: { ...process.env, ACE_HOME: layout.home },
  });
}

const group = new ProcessGroup(profile(name, layout), {
  output: process.stdout,
  color: process.stdout.isTTY && !process.env.NO_COLOR,
});
group.log(describe(name, layout));
if (name === "dev:web") void announceToken(layout, group);
process.exitCode = await runUntilInterrupted(group);

function describe(profileName: string, dev: DevLayout): string {
  const parts = [`${profileName}: Ctrl-C stops everything`];
  if (usesDaemon(name)) parts.push(`daemon ${daemonUrl(dev)} (ACE_HOME=${dev.home})`);
  if (profileName !== "daemon") parts.push(`web ${webUrl(dev)}`);
  return parts.join(" · ");
}

/** The browser build asks for a token; hand the dev daemon's over in the URL fragment. */
async function announceToken(dev: DevLayout, runner: ProcessGroup): Promise<void> {
  const path = join(dev.home, "daemon-token");
  for (let attempt = 0; attempt < 120 && !existsSync(path); attempt++) await delay(500);
  if (!existsSync(path)) return;
  const token = readFileSync(path, "utf8").trim();
  runner.log(`open ${webUrl(dev)}#token=${token} (development data only)`);
}
