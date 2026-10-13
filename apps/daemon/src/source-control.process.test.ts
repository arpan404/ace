import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SettingsService } from "@ace/settings";
import { createCommandRunner } from "@ace/forge";
import { SourceControl } from "./source-control.ts";
import { fixture } from "./socket-test-support.ts";

it("host preferences survive restart and a rescan observes the machine's current account", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-source-control-"));
  const account = join(root, "account");
  await writeFile(account, "octo");
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(
    join(root, "gh"),
    `#!${process.execPath}\nimport {readFileSync} from 'node:fs'; const args=process.argv.slice(2); if(args[0]==='--version') console.log('gh version 2.0.0'); else if(args[1]==='user') console.log(JSON.stringify({login:readFileSync(process.env.ACE_ACCOUNT,'utf8')})); else console.log('auth status');`,
    { mode: 0o755 },
  );
  const runner = () =>
    createCommandRunner({ cwd: root, env: { PATH: root, ACE_ACCOUNT: account } });
  let settings = new SettingsService({ dataDir: root });
  const socket = await fixture({
    settings,
    sourceControl: new SourceControl(settings, runner, root),
  });
  try {
    const client = await socket.connect();
    await client.next();
    client.send({
      type: "settings.set",
      requestId: "save",
      key: "sourceControl.preferences",
      layer: { kind: "global" },
      value: {
        hosts: [
          { host: "github.com", account: "octo" },
          { host: "git.example.com", account: "octo" },
        ],
        host: "git.example.com",
        remote: "upstream",
      },
    });
    expect(await client.next()).toMatchObject({ type: "settings.result", ok: true });
    client.send({
      type: "source-control.request",
      requestId: "first",
      operation: { op: "readiness" },
    });
    expect(await client.next()).toMatchObject({
      type: "source-control.result",
      result: {
        kind: "readiness",
        readiness: { api: "ready", preferences: { host: "git.example.com", remote: "upstream" } },
      },
    });
    await writeFile(account, "other");
    client.send({
      type: "source-control.request",
      requestId: "rescan",
      operation: { op: "readiness" },
    });
    expect(await client.next()).toMatchObject({
      result: { kind: "readiness", readiness: { account: "other", api: "account_mismatch" } },
    });
    await settings.close();
    settings = new SettingsService({ dataDir: root });
    expect(
      (
        await new SourceControl(settings, runner, root).readiness(
          root,
          new AbortController().signal,
        )
      ).preferences,
    ).toMatchObject({
      host: "git.example.com",
      remote: "upstream",
      hosts: [
        { host: "github.com", account: "octo" },
        { host: "git.example.com", account: "octo" },
      ],
    });
  } finally {
    await socket.close();
    await settings.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("only an administrator can save global source control preferences", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-source-control-scope-"));
  const settings = new SettingsService({ dataDir: root });
  const socket = await fixture({ settings });
  try {
    for (const admin of [false, true]) {
      const issued = socket.store.devices.create(
        admin ? "Administrator" : "Operator",
        // Local sockets admit desktop device credentials; admin is the boundary under test.
        admin ? ["read", "operate", "admin", "desktop"] : ["read", "operate", "desktop"],
        1000,
      );
      const client = await socket.open();
      client.send({
        type: "hello",
        protocolVersion: 1,
        deviceId: issued.device.id,
        token: issued.token,
      });
      expect(await client.next()).toMatchObject({ type: "welcome" });
      client.send({
        type: "settings.set",
        requestId: "preferences",
        key: "sourceControl.preferences",
        layer: { kind: "global" },
        value: {
          hosts: [{ host: "github.com", account: "octo" }],
          host: "github.com",
          remote: "upstream",
        },
      });
      expect(await client.next()).toMatchObject({ type: "settings.result", ok: admin });
      expect((await settings.get("sourceControl.preferences")).value.remote).toBe(
        admin ? "upstream" : "origin",
      );
    }
  } finally {
    await socket.close();
    await settings.close();
    await rm(root, { recursive: true, force: true });
  }
});
