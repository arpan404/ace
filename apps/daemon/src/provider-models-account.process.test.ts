import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelCatalog, openModelStorage, normalizeCodex, ModelInstance } from "@ace/models";
import { handleModelRequest } from "./models.ts";

test("explicit model refresh discards the previous account choices even if the new account is offline", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-model-account-"));
  const instance = ModelInstance.parse({
    id: "codex",
    provider: "codex",
    executable: "/fixture",
    cwd: home,
    loginRevision: "same-path",
  });
  let offline = false;
  const make = () =>
    new ModelCatalog({
      storage: openModelStorage(join(home, "models.sqlite")),
      instances: [instance],
      now: () => 1,
      deadline: () => () => {},
      discover: async () => {
        if (offline) throw new Error("New account offline");
        return normalizeCodex(
          {
            data: [
              {
                id: "old",
                model: "old-account",
                displayName: "Old account",
                isDefault: true,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: "high",
              },
            ],
            nextCursor: null,
          },
          instance,
        );
      },
    });
  let catalog = make();
  try {
    await catalog.refresh();
    expect(catalog.list().models.map((m) => m.id)).toEqual(["old-account"]);
    offline = true;
    const refresh = handleModelRequest(catalog, {
      type: "models.refresh",
      requestId: "refresh",
      filter: { instance: "codex" },
    });
    expect(catalog.list().models).toEqual([]);
    await refresh;
    expect(catalog.list().models).toEqual([]);
    await catalog.close();
    catalog = make();
    expect(catalog.list().models).toEqual([]);
  } finally {
    await catalog.close();
    await rm(home, { recursive: true, force: true });
  }
});

// Late old-account writes and repeated refresh races. Not executed (tests run at merge).
test("concurrent account refreshes revoke even an old metadata write already pending on disk", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-model-account-race-"));
  const instance = ModelInstance.parse({
    id: "codex",
    provider: "codex",
    executable: "/fixture",
    cwd: home,
    loginRevision: "same-path",
  });
  const storage = openModelStorage(join(home, "models.sqlite"));
  const writing = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let held = false,
    offline = false;
  const catalog = new ModelCatalog({
    storage: {
      ...storage,
      async replace(entry) {
        if (held) {
          writing.resolve();
          await release.promise;
        }
        storage.replace(entry);
      },
    },
    instances: [instance],
    now: () => 1,
    deadline: () => () => {},
    discover: async () => {
      if (offline) throw new Error("New account offline");
      return normalizeCodex(
        {
          data: [
            {
              id: "old",
              model: "old-account",
              displayName: "Old account",
              isDefault: true,
              supportedReasoningEfforts: [],
              defaultReasoningEffort: "high",
            },
          ],
          nextCursor: null,
        },
        instance,
      );
    },
  });
  try {
    await catalog.refresh();
    held = true;
    const old = catalog.refresh();
    await writing.promise;
    offline = true;
    const one = handleModelRequest(catalog, {
      type: "models.refresh",
      requestId: "one",
      filter: { instance: "codex" },
    });
    const two = handleModelRequest(catalog, {
      type: "models.refresh",
      requestId: "two",
      filter: { instance: "codex" },
    });
    expect(catalog.list().models).toEqual([]);
    release.resolve();
    await Promise.all([old, one, two]);
    expect(catalog.list().models).toEqual([]);
    await catalog.close();
    const cold = new ModelCatalog({
      storage: openModelStorage(join(home, "models.sqlite")),
      instances: [instance],
      now: () => 1,
      deadline: () => () => {},
      discover: async () => {
        throw new Error("Offline");
      },
    });
    try {
      expect(cold.list().models).toEqual([]);
    } finally {
      await cold.close();
    }
  } finally {
    release.resolve();
    await catalog.close();
    await rm(home, { recursive: true, force: true });
  }
});
