import { expect, test } from "vitest";
import { discoverProviders } from "@ace/provider-kit/discovery";
import { JsonRpcPeer } from "@ace/provider-kit/jsonrpc";
import { spawnSupervised } from "@ace/provider-kit/process";
import type { InitializeParams } from "./generated/InitializeParams.ts";
import { obj } from "./native.ts";

test.skipIf(process.env["ACE_LIVE_CLI"] !== "1")(
  "installed Codex accepts the experimental initialize handshake",
  async () => {
    const cli = (await discoverProviders()).codex;
    if (!cli.path) throw new Error("Codex is not installed");
    const proc = spawnSupervised({
      command: cli.path,
      args: ["app-server"],
      cwd: process.cwd(),
      env: {},
      name: "ace-codex-handshake",
    });
    const rpc = new JsonRpcPeer(proc);
    try {
      const result = await rpc.request("initialize", {
        clientInfo: { name: "ace", title: "ace", version: "0.0.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      } satisfies InitializeParams);
      expect(obj(result)["userAgent"]).toEqual(expect.any(String));
      rpc.notify("initialized");
    } finally {
      rpc.close();
      await proc.stop();
    }
  },
);
