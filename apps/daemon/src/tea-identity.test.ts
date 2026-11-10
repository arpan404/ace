import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "vitest";
import { SettingsService } from "@ace/settings";
import { teaIssueWrites, WriteDispatch, type CommandRunner } from "@ace/forge";
import { SourceControl } from "./source-control.ts";

for (const forge of ["gitea", "forgejo"] as const) {
  test(`${forge} account switch during a write withholds the successful result`, async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-tea-identity-"));
    const settings = new SettingsService({ dataDir: root });
    let account = "alice";
    let mutations = 0;
    const runner: CommandRunner = async (request) => {
      let body: unknown;
      if (request.args[0] === "login")
        body = [{ name: "work", url: "https://git.example", user: account }];
      else if (request.args[1] === "user") body = { login: account };
      else {
        request.dispatch?.prepare?.();
        request.dispatch?.record();
        mutations++;
        account = "bob";
        body = { number: 1 };
      }
      return {
        code: 0,
        stdout: JSON.stringify(body),
        truncated: false,
        http: { status: 200, headers: {} },
      };
    };
    const source = new SourceControl(settings, () => runner, root);
    try {
      await settings.set(
        "sourceControl.preferences",
        {
          hosts: [{ host: "github.com" }, { host: "git.example", forge, account: "alice" }],
          host: "git.example",
          remote: "origin",
        },
        { kind: "global" },
      );
      const repository = { forge, host: "git.example", owner: "team", name: "app" };
      const identity = await source.writeIdentity(
        root,
        repository,
        teaIssueWrites,
        new AbortController().signal,
      );
      const dispatch = new WriteDispatch();
      const result = await identity.runner({
        command: "tea",
        args: [
          "api",
          "repos/team/app/issues",
          "--method",
          "POST",
          "--login",
          "work",
          "--include",
          "--data",
          "@-",
        ],
        input: '{"title":"Bug"}',
        mode: "json",
        signal: new AbortController().signal,
        dispatch,
      });
      expect(result.identityChanged).toBe(true);
      expect(mutations).toBe(1);
      await expect(
        identity.runner({
          command: "tea",
          args: [
            "api",
            "repos/team/app/issues",
            "--method",
            "POST",
            "--login",
            "work",
            "--include",
            "--data",
            "@-",
          ],
          input: '{"title":"Other"}',
          mode: "json",
          signal: new AbortController().signal,
          dispatch: new WriteDispatch(),
        }),
      ).rejects.toBeDefined();
      expect(mutations).toBe(1);
    } finally {
      source.close();
      await settings.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
