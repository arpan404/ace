import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalHome } from "@ace/accounts";
import {
  assertTestEnvironmentIsolation,
  testHomePathVariables,
} from "@ace/provider-kit/test-isolation";
import { isolatedTestEnvironment } from "../../../scripts/test-home-policy.ts";

/** Preserve only explicit fixture controls after applying the shared child environment policy. */
export function realDaemonEnvironment(
  ambient: NodeJS.ProcessEnv,
  home: string,
  realHome: string,
): NodeJS.ProcessEnv {
  const env = isolatedTestEnvironment({ ...ambient, ACE_DEVICE_LIVE: undefined }, home, realHome);
  for (const [key, value] of Object.entries(ambient))
    if (
      /^ACE_E2E_(?:DAEMON_PORT|WEB_PORT|FAKE_PORT|TURN_DELAY_MS|LIMIT_AFTER_TURNS|LIMIT_RESET_MS|LONG_TURNS)$/.test(
        key,
      )
    )
      env[key] = value;
  return {
    ...env,
    ACE_HOME: home,
    ACE_ACCOUNTS_DB: join(home, "accounts.sqlite"),
    ACE_LOG_LEVEL: "warn",
  };
}

/** Check restored selectors before any daemon service can open a store or CLI home. */
export async function assertRealDaemonEnvironment(
  env: NodeJS.ProcessEnv,
  home: string,
): Promise<void> {
  assertTestEnvironmentIsolation(env);
  const root = await canonicalHome(home);
  for (const [key, value] of Object.entries(env)) {
    if (!value || key === "ACE_TEST_REAL_HOME") continue;
    if (
      !testHomePathVariables.includes(key) &&
      !key.startsWith("XDG_") &&
      !(key.startsWith("ACE_") && /_(?:HOME|DIR|ROOT|FILE)$/.test(key))
    )
      continue;
    for (const path of key.endsWith("_DIRS") ? value.split(delimiter) : [value]) {
      const difference = relative(root, await canonicalHome(resolve(path)));
      if (difference === ".." || difference.startsWith(`..${sep}`) || isAbsolute(difference))
        throw new Error(`E2E environment selector ${key} escapes the fixture home`);
    }
  }
}
