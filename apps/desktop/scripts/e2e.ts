#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { desktop, repo } from "./common.ts";

/** `bun run desktop:e2e`: the Playwright-for-Electron smoke test against the fake daemon. */
try {
  execFileSync(
    process.execPath,
    [
      join(repo, "node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      join(desktop, "vitest.e2e.config.ts"),
    ],
    { cwd: desktop, stdio: "inherit", env: { ...process.env, ACE_E2E_ELECTRON: "1" } },
  );
} catch {
  process.exitCode = 1;
}
