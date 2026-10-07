import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SettingsService } from "./index.ts";

test("retired Cursor CLI defaults migrate on read and legacy writes keep the SDK selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-settings-"));
  const path = join(root, "settings.json");
  await writeFile(
    path,
    `{
    // keep this owner's comment
    "version": 2, "settings": {
      "providers.configuration": [{"provider":"cursor","instance":"cursor-cli-default","binaryPath":"/fixture/agent","defaultModel":"composer-2.5"}],
      "future": {"preserved": true}
    }
  }`,
  );
  const service = new SettingsService({ dataDir: root });
  try {
    expect((await service.get("providers.configuration")).value).toEqual([
      { provider: "cursor", instance: "cursor-sdk-default", defaultModel: "composer-2.5" },
    ]);
    await service.set(
      "providers.configuration",
      [
        {
          provider: "cursor",
          instance: "cursor-cli-default",
          binaryPath: "/fixture/agent",
          defaultModel: "auto",
        },
      ],
      { kind: "global" },
    );
    expect((await service.get("providers.configuration")).value).toEqual([
      { provider: "cursor", instance: "cursor-sdk-default", defaultModel: "auto" },
    ]);
    const text = await readFile(path, "utf8");
    expect(text).toContain("keep this owner's comment");
    expect(text).toContain('"preserved": true');
    expect(text).not.toContain("cursor-cli-default");
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
