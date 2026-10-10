import { expect, test } from "vitest";
import { join } from "node:path";
import { lstat, readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { defaultAccountBadgeColor } from "@ace/accounts/labels";
import { openRegistry } from "@ace/accounts";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { registerImplicitAccounts } from "./account-homes.ts";
import { harness } from "./account-management-test-support.ts";

test("renaming the CLI login over the socket survives reopening and rediscovery without changing its home or default", async () => {
  const f = await harness();
  const id = "codex-cli-default";
  const home = join(f.normalHome, ".codex");
  try {
    await mkdir(home);
    await writeFile(join(home, "untouched"), "CLI home sentinel");
    const before = await lstat(home);
    expect(await f.status(id)).toMatchObject({
      label: "Your CLI login",
      shortLabel: "Y",
      badgeColor: defaultAccountBadgeColor("codex-cli-default"),
      isDefault: true,
    });
    const other = await f.add();
    await f.request(f.owner, {
      type: "accounts.setDefault",
      requestId: f.rid(),
      provider: "codex",
      instanceId: other.id,
    });
    expect(
      await f.request(f.owner, {
        type: "accounts.rename",
        requestId: f.rid(),
        instanceId: id,
        label: "Studio",
      }),
    ).toMatchObject({ account: { label: "Studio", shortLabel: "S", isDefault: false } });
    const reopened = await openRegistry(join(f.dataDir, "accounts.sqlite"));
    try {
      await registerImplicitAccounts(reopened, f.env);
      expect(reopened.summary(id, 100)).toMatchObject({
        label: "Studio",
        shortLabel: "S",
        badgeUsesInitial: true,
        cliHome: home,
        isDefault: false,
      });
      expect(reopened.summary(other.id, 100)?.isDefault).toBe(true);
      reopened.rename(id, "Studio", { shortLabel: "👩‍💻", badgeColor: "violet" });
    } finally {
      reopened.close();
    }
    const again = await openRegistry(join(f.dataDir, "accounts.sqlite"));
    try {
      await registerImplicitAccounts(again, f.env);
      expect(again.summary(id, 100)).toMatchObject({
        label: "Studio",
        shortLabel: "👩‍💻",
        badgeColor: "violet",
        badgeUsesInitial: false,
        isDefault: false,
      });
      again.rename(id, "Home", { badgeUsesInitial: true });
      expect(again.summary(id, 100)).toMatchObject({
        label: "Home",
        shortLabel: "H",
        badgeUsesInitial: true,
      });
    } finally {
      again.close();
    }
    expect(await readdir(home)).toEqual(["untouched"]);
    expect(await readFile(join(home, "untouched"), "utf8")).toBe("CLI home sentinel");
    const after = await lstat(home);
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
    await expect(lstat(join(f.normalHome, ".claude"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await f.close();
  }
});

test("older CLI login records acquire a palette initial badge without creating their home", async () => {
  const f = await harness();
  const path = join(f.dataDir, "accounts.sqlite");
  const db = new DatabaseSync(path);
  try {
    db.exec(
      `UPDATE accounts SET instance=json_remove(instance,'$.shortLabel','$.badgeColor') WHERE id='codex-cli-default'`,
    );
    const reopened = await openRegistry(path);
    try {
      expect(reopened.summary("codex-cli-default", 100)).toMatchObject({
        shortLabel: "Y",
        badgeColor: defaultAccountBadgeColor("codex-cli-default"),
        badgeUsesInitial: true,
        isDefault: true,
      });
      await expect(lstat(join(f.normalHome, ".codex"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      reopened.close();
    }
  } finally {
    db.close();
    await f.close();
  }
});

test("old automatic neutral badges receive a palette colour once and later chosen colours survive", async () => {
  const f = await harness();
  const path = join(f.dataDir, "accounts.sqlite");
  const db = new DatabaseSync(path);
  try {
    db.exec(`DELETE FROM account_metadata_migrations WHERE name='badge-palette';
      UPDATE accounts SET instance=json_set(instance,'$.badgeColor','neutral') WHERE id='codex-cli-default';
      UPDATE accounts SET instance=json_set(instance,'$.badgeColor','rose') WHERE id='claude-cli-default';`);
    const reopened = await openRegistry(path);
    try {
      expect(reopened.summary("codex-cli-default", 100)?.badgeColor).toBe(
        defaultAccountBadgeColor("codex-cli-default"),
      );
      expect(reopened.summary("claude-cli-default", 100)?.badgeColor).toBe("rose");
      reopened.rename("codex-cli-default", "Studio", { badgeColor: "neutral" });
    } finally {
      reopened.close();
    }
    const again = await openRegistry(path);
    try {
      await registerImplicitAccounts(again, f.env);
      expect(again.summary("codex-cli-default", 100)?.badgeColor).toBe("neutral");
      await expect(lstat(join(f.normalHome, ".codex"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      again.close();
    }
  } finally {
    db.close();
    await f.close();
  }
});
