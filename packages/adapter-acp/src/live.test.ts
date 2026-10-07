import { it, expect } from "vitest";
import { findExecutable } from "@ace/provider-kit/discovery";
import { JsonRpcPeer } from "@ace/provider-kit/jsonrpc";
import { spawnSupervised } from "@ace/provider-kit/process";
import { object } from "./data.ts";
import { antigravityQuirks } from "./quirks/antigravity.ts";
for (const quirks of [antigravityQuirks]) {
  it.skipIf(process.env["ACE_LIVE_CLI"] !== "1")(
    `${quirks.provider} initializes its installed ACP server without a model session`,
    async () => {
      const path = await findExecutable(quirks.command);
      if (!path) throw new Error(`Opted-in live ACP check requires installed ${quirks.command}`);
      const proc = spawnSupervised({
        command: path,
        args: quirks.args,
        cwd: process.cwd(),
        env: {},
        name: quirks.provider,
      });
      const rpc = new JsonRpcPeer(proc);
      try {
        const result = object(
          await rpc.request("initialize", {
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
              _meta: quirks.clientMeta,
            },
            clientInfo: { name: "ace-live-initialize", version: "0.0.0" },
          }),
        );
        expect(result["protocolVersion"]).toBe(1);
      } finally {
        rpc.close();
        await proc.stop();
      }
    },
    30000,
  );
}
