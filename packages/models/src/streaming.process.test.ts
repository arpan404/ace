import { expect, test } from "vitest";
import { spawnSupervised } from "@ace/provider-kit/process";
import { createModelDiscovery } from "./index.ts";
import { codexPayload, fakeCli, instance, workspace } from "./testing/support.ts";

test("stderr flood rejects otherwise valid metadata and reaps the CLI", async () => {
  const work = await workspace();
  const config = {
    ...instance(),
    cwd: work.path,
    args: [await fakeCli(work.path)],
    env: { FAKE_PROVIDER: "codex", FAKE_PAYLOAD: JSON.stringify(codexPayload()) },
  };
  let reaped = false;
  const discovery = createModelDiscovery({
    spawn(options) {
      const proc = spawnSupervised(options);
      void proc.exited.then(() => {
        reaped = true;
      });
      return proc;
    },
  });
  try {
    await expect(
      discovery(
        { ...config, env: { ...config.env, FAKE_STDERR: "1" } },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(reaped).toBe(true);
  } finally {
    await work.close();
  }
});
