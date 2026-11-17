import { expect, test } from "vitest";
import { ModelCatalog, type ModelInstance } from "./index.ts";

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
