import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";

import { NetService } from "@ace/shared/Net";
import { cli } from "./cli";
import { version } from "../package.json" with { type: "json" };

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

const rewriteCliAliases = () => {
  const args = process.argv.slice(2);
  switch (args[0]) {
    case "--serve": {
      process.argv = [process.argv[0]!, process.argv[1]!, "serve", ...args.slice(1)];
      return;
    }
    case "--restart": {
      process.argv = [process.argv[0]!, process.argv[1]!, "daemon", "restart", ...args.slice(1)];
      return;
    }
    default:
      return;
  }
};

rewriteCliAliases();

Command.run(cli, { version }).pipe(
  Effect.scoped,
  Effect.provide(CliRuntimeLayer),
  NodeRuntime.runMain,
);
