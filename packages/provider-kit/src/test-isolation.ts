import { realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createTestHomeGuard } from "./test-isolation-policy.ts";
export { createTestHomeGuard, type TestHomeGuardPorts } from "./test-isolation-policy.ts";

/** Path selectors consumed by application storage, provider history and login shells. */
export const testHomePathVariables: readonly string[] = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TMPDIR",
  "TMP",
  "TEMP",
  "ACE_HOME",
  "ACE_ACCOUNTS_DB",
  "ACE_WORKSPACE_ROOT",
  "ACE_DAEMON_TOKEN_FILE",
  "ACE_SCREEN_HELPER",
  "ACE_SCREEN_HELPER_MANIFEST",
  "ACE_APNS_KEY_FILE",
  "ACE_VAPID_KEY_FILE",
  "ACE_RELEASE_PUBLIC_KEY_FILE",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "CURSOR_CONFIG_DIR",
  "CURSOR_DATA_DIR",
  "OPENCODE_DB",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "PI_CODING_AGENT_DIR",
  "ZDOTDIR",
  "BASH_ENV",
  "ENV",
  "INPUTRC",
  "NODE_REPL_HISTORY",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "BUN_INSTALL_CACHE_DIR",
  "NPM_CONFIG_USERCONFIG",
  "ANDROID_USER_HOME",
  "ANDROID_AVD_HOME",
  "SHELL",
  "OPENSSL_CONF",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_V8_COVERAGE",
];
const homeSchema = z.string().min(1);
const environmentSchema = z.record(z.string(), z.string().optional());
export function parseTestEnvironment(input: unknown): NodeJS.ProcessEnv {
  return environmentSchema.parse(input);
}

/** Test-only I/O boundary. Unset means no parsing, path operations or filesystem access. */
export function assertTestHomeIsolation(
  candidate: string,
  realHome = process.env.ACE_TEST_REAL_HOME,
): void {
  if (!realHome) return;
  createTestHomeGuard(homeSchema.parse(realHome), {
    cwd: process.cwd(),
    paths: path,
    realpath: realpathSync,
  })(candidate);
}

export function assertTestEnvironmentIsolation(env: NodeJS.ProcessEnv): void {
  const realHome = process.env.ACE_TEST_REAL_HOME;
  if (!realHome) return;
  const parsed = parseTestEnvironment(env);
  const guard = createTestHomeGuard(homeSchema.parse(realHome), {
    cwd: process.cwd(),
    paths: path,
    realpath: realpathSync,
  });
  for (const [name, value] of Object.entries(parsed)) {
    if (name === "ACE_TEST_REAL_HOME") continue;
    if (
      value &&
      (testHomePathVariables.includes(name) ||
        /^XDG_.*_(?:HOME|DIR|DIRS)$/.test(name) ||
        (name.startsWith("ACE_") && /_(?:HOME|DIR|ROOT|FILE)$/.test(name)))
    ) {
      for (const candidate of name.endsWith("_DIRS") ? value.split(path.delimiter) : [value])
        if (candidate) guard(candidate);
    }
  }
}
