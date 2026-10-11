import { afterEach, expect, test } from "vitest";
import { join } from "node:path";
import { defaultAccountBadgeColor } from "./labels.ts";
import { createInstance, openRegistry } from "./index.ts";
import { cleanup, temp } from "./test-support.ts";

afterEach(cleanup);

test("named accounts derive labels, and edited labels and colours survive reopening the store", async () => {
  const root = await temp();
  const path = join(root, "accounts.sqlite");
  const registry = await openRegistry(path);
  try {
    await registry.register(
      createInstance({ id: "work", provider: "codex", label: "Work", homeDir: join(root, "work") }),
    );
    await registry.register(
      createInstance({
        id: "personal",
        provider: "codex",
        label: "Personal",
        homeDir: join(root, "personal"),
      }),
    );
    expect(registry.summary("work", 0)?.shortLabel).toBe("W");
    expect(registry.summary("personal", 0)?.shortLabel).toBe("P");
    registry.rename("work", "Studio", { shortLabel: "ST", badgeColor: "violet" });
  } finally {
    registry.close();
  }
  const reopened = await openRegistry(path);
  try {
    expect(reopened.summary("work", 0)).toMatchObject({
      label: "Studio",
      shortLabel: "ST",
      badgeColor: "violet",
    });
    expect(reopened.summary("personal", 0)).toMatchObject({ label: "Personal", shortLabel: "P" });
    reopened.rename("work", "Studio", { badgeColor: null });
    expect(reopened.summary("work", 0)?.badgeColor).toBe(defaultAccountBadgeColor("work"));
    expect(reopened.summary("work", 0)?.shortLabel).toBe("ST");
  } finally {
    reopened.close();
  }
});

test("new Unicode badges persist while old three-letter badges remain readable", async () => {
  const root = await temp();
  const path = join(root, "accounts.sqlite");
  const registry = await openRegistry(path);
  try {
    await registry.register({
      ...createInstance({
        id: "legacy",
        provider: "codex",
        label: "Legacy",
        homeDir: join(root, "legacy"),
      }),
      shortLabel: "CLI",
    });
    await registry.register(
      createInstance({
        id: "emoji",
        provider: "codex",
        label: "Emoji",
        homeDir: join(root, "emoji"),
      }),
    );
    expect(() => registry.rename("emoji", "Emoji", { shortLabel: "ABC" })).toThrow();
    expect(registry.summary("emoji", 0)?.shortLabel).toBe("E");
    registry.rename("emoji", "Emoji", { shortLabel: "👩‍💻" });
  } finally {
    registry.close();
  }
  const reopened = await openRegistry(path);
  try {
    expect(reopened.summary("legacy", 0)?.shortLabel).toBe("CLI");
    expect(reopened.summary("emoji", 0)?.shortLabel).toBe("👩‍💻");
  } finally {
    reopened.close();
  }
});
