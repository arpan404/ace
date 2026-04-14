import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";

import { NetService } from "@ace/shared/Net";
import { cli, formatRootCliBanner } from "./cli";
import { version } from "../package.json" with { type: "json" };

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

const shouldRenderBootBanner = (args: ReadonlyArray<string>): boolean => {
  if (process.env.ACE_CLI_SUPPRESS_BOOT_BANNER === "1") {
    return false;
  }
  if (!process.stdout.isTTY) {
    return false;
  }
  if (args.length === 0) {
    return false;
  }
  if (args.includes("--json")) {
    return false;
  }
  if (args.includes("--version") || args.includes("-v")) {
    return false;
  }
  return true;
};

const isHelpInvocation = (args: ReadonlyArray<string>): boolean =>
  args.includes("--help") || args.includes("-h") || args[0] === "help";

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

const invocationArgs = process.argv.slice(2);
if (shouldRenderBootBanner(invocationArgs)) {
  process.stdout.write(formatRootCliBanner());
  if (isHelpInvocation(invocationArgs)) {
    process.stdout.write("\n");
  }
}

Command.run(cli, { version }).pipe(
  Effect.scoped,
  Effect.provide(CliRuntimeLayer),
  NodeRuntime.runMain,
);
