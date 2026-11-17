import { expect, test } from "vitest";
import { ModelCatalog, ModelInstance } from "./index.ts";

// A managed account's catalog row carries the daemon's environment with the account's home
// over it. A person's shell can export hundreds of variables, some of them long.
test("an account whose environment is the person's full shell environment still discovers its models", async () => {
  const env: Record<string, string> = {
    PATH: Array.from({ length: 400 }, (_, index) => `/opt/tool-${index}/bin`).join(":"),
    LS_COLORS: "di=01;34:".repeat(1_500),
    CODEX_HOME: "/temporary/account-home",
  };
  for (let index = 0; index < 600; index++) env[`SHELL_SETTING_${index}`] = `value-${index}`;
  const discovered: ModelInstance[] = [];
  const catalog = new ModelCatalog({
    now: () => 100,
    deadline: () => () => {},
    storage: { load: () => [], replace() {}, close() {}, remove() {} },
    discover: async (instance) => {
      discovered.push(instance);
      return [];
    },
  });
  try {
    catalog.registerInstance({
      id: "account",
      provider: "codex",
      executable: "/controlled/codex",
      cwd: "/temporary/account-home",
      env,
      loginRevision: "1",
    });
    await catalog.refresh({ instance: "account" });
    expect(discovered.map((instance) => instance.env)).toEqual([env]);
  } finally {
    await catalog.close();
  }
});

/** Whether a catalog row with this environment is accepted. */
function accepts(env: Record<string, string>): boolean {
  return ModelInstance.safeParse({
    id: "account",
    provider: "codex",
    executable: "/controlled/codex",
    cwd: "/temporary/account-home",
    env,
    loginRevision: "1",
  }).success;
}

test("an environment no process could start with is refused", () => {
  const value = "x".repeat(100_000);
  // 30 variables of 100 KB is over every platform's launch limit; one over 128 KiB is over its
  // storage bound.
  expect(accepts(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`V${i}`, value])))).toBe(
    false,
  );
  expect(accepts({ HUGE: "x".repeat(131_073) })).toBe(false);
  expect(accepts({ PATH: "/usr/bin", LONG: value })).toBe(true);
});
