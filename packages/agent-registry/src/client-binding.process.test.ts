import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { registry, temporary, executable } from "./testing/support.ts";

const fetcher: typeof fetch = async () => {
  throw new Error("No network expected");
};

test("client command binding persists an installed ACP identity without executing it and revalidates its executable", async () => {
  const f = await temporary();
  const service = await registry(f.root, fetcher);
  try {
    const marker = join(f.root, "launched");
    const command = await executable(f.root, "agent", `#!/bin/sh\ntouch '${marker}'\n`);
    const identity = {
      acpAgentId: "local:custom",
      installationId: "custom-1",
      instanceId: "custom-instance",
    };
    const bound = await service.handle({
      type: "registry.bind",
      requestId: "bind",
      ...identity,
      version: "1",
      command,
      args: ["--stdio"],
    });
    expect(bound.result).toMatchObject({
      ok: true,
      installation: { ...identity, profileRevision: "generic-v1", evidence: "user_local_binding" },
    });
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    const restored = await registry(f.root, fetcher);
    try {
      expect(restored.has(identity)).toBe(true);
      expect(await restored.resolve(identity)).toMatchObject({ command, args: ["--stdio"] });
      await writeFile(command, "#!/bin/sh\nexit 2\n");
      await expect(restored.resolve(identity)).rejects.toThrow();
    } finally {
      await restored.close();
    }
    expect(
      (
        await service.handle({
          type: "registry.bind",
          requestId: "impostor",
          ...identity,
          acpAgentId: "official:custom",
          installationId: "impostor",
          version: "1",
          command,
          args: [],
        })
      ).result,
    ).toMatchObject({ ok: false });
    expect(
      (
        await service.handle({
          type: "registry.bind",
          requestId: "runner",
          ...identity,
          installationId: "runner",
          version: "1",
          command: await executable(f.root, "npx"),
          args: [],
        })
      ).result,
    ).toMatchObject({ ok: false });
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await service.close();
    await f.close();
  }
});
