import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SettingsService } from "@ace/settings";
import { ForgeRepository } from "@ace/protocol";
import { SourceControl } from "./source-control.ts";
import { ForgeBackends } from "./forge-backends.ts";
import { ForgeReplyReceipts } from "./forge-reply-receipts.ts";
import { Store } from "./store.ts";

// An actual settings/SQLite edge proves hidden repositories cannot reach the CLI.
test("a hidden GitLab repository refuses writes before identity or dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-hosted-hidden-"));
  const settings = new SettingsService({ dataDir: root });
  const store = new Store(join(root, "events.sqlite"));
  const repository = ForgeRepository.parse({
    forge: "gitlab",
    host: "gitlab.com",
    owner: "team",
    name: "repo",
  });
  let requests = 0;
  const runner = async () => {
    requests++;
    throw new Error("Hidden repository reached CLI");
  };
  const source = new SourceControl(
    settings,
    () => runner,
    root,
    () => 1,
  );
  const signal = new AbortController().signal;
  try {
    await settings.set(
      "sourceControl.preferences",
      {
        hosts: [{ host: "gitlab.com", forge: "gitlab" }],
        host: "gitlab.com",
        remote: "origin",
      },
      { kind: "global" },
    );
    const backends = new ForgeBackends({
      git: {
        repositoryInfo: async () => ({
          root,
          branch: "topic",
          detached: false,
          head: "a".repeat(40),
          upstream: null,
          ahead: 0,
          behind: 0,
          remotes: [
            {
              name: "origin",
              fetchUrls: ["https://gitlab.com/team/repo.git"],
              pushUrls: ["https://gitlab.com/team/repo.git"],
            },
          ],
        }),
      },
      now: () => 1,
      runner: () => runner,
      sourceControl: source,
      replyReceipts: new ForgeReplyReceipts(store),
      signal,
      configs: { forCheckout: () => ({ hidden: [repository], added: [], primary: null }) },
    });
    await expect(
      backends.hostRunner(
        root,
        repository,
        [{ method: "PUT", endpoint: /^projects\/team%2Frepo\/merge_requests\/1\/merge$/ }],
        signal,
      ),
    ).rejects.toThrow("repository_hidden");
    expect(requests).toBe(0);
  } finally {
    source.close();
    await settings.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
