import {
  ForgeLocalStack,
  type ForgeStack,
  type ForgeStackExpected,
  type ForgeStackOperation,
} from "@ace/protocol/forge-stacks";
import type { CommandRunner } from "./command.ts";
import { redactData } from "./redact.ts";
import { ForgeError } from "./errors.ts";

import {
  canPublishStack,
  matchesLocalStack,
  matchesStackBranches,
  sameLocalStack,
} from "./stack-plan.ts";
export class LocalStacks {
  readonly #runner: CommandRunner;
  readonly #command: string;
  constructor(runner: CommandRunner, command = "gh") {
    this.#runner = runner;
    this.#command = command;
  }
  async read(signal: AbortSignal): Promise<ForgeLocalStack> {
    const response = await this.#runner({
      command: this.#command,
      args: ["stack", "view", "--json"],
      mode: "json",
      signal,
    });
    if (response.code !== 0) throw new ForgeError("unsupported");
    let body: unknown;
    try {
      body = redactData(JSON.parse(response.stdout));
    } catch {
      throw new ForgeError("invalid_data");
    }
    const result = ForgeLocalStack.safeParse(body);
    if (!result.success) throw new ForgeError("invalid_data");
    return { ...result.data, raw: body };
  }
  async rebase(
    action: "rebase" | "continue" | "abort" | "push",
    expected: ForgeStackExpected,
    stack: ForgeStack,
    signal: AbortSignal,
    allowed: () => boolean,
    started: (stage: "rebase" | "push") => void = () => {},
  ): Promise<ForgeStackOperation> {
    const current = await this.read(signal);
    if (
      !expected.local ||
      !sameLocalStack(expected.local, current) ||
      !(action === "rebase"
        ? matchesLocalStack(current, stack)
        : matchesStackBranches(current, stack))
    )
      throw new ForgeError("conflict");
    if (
      action !== "abort" &&
      (!canPublishStack(stack) ||
        stack.layers.some((layer) => layer.queueState !== null) ||
        current.branches.some((branch) => branch.isQueued))
    )
      throw new ForgeError("conflict");
    if (
      action === "rebase" &&
      current.branches.some(
        (branch) =>
          !branch.isMerged &&
          branch.head !== stack.layers.find((layer) => layer.number === branch.pr?.number)?.headSha,
      )
    )
      throw new ForgeError("conflict");
    if (!allowed()) throw new ForgeError("forbidden");
    started(action === "push" ? "push" : "rebase");
    const response =
      action === "push"
        ? { code: 0 }
        : await this.#runner({
            command: this.#command,
            args: [
              "stack",
              "rebase",
              ...(action === "rebase" ? ["--remote", "origin"] : [`--${action}`]),
            ],
            mode: "json",
            signal,
          });
    if (response.code === 3 || response.code === 7)
      return {
        action,
        state: "conflict",
        message:
          "The local stack rebase needs conflict resolution. Resolve and stage the files, then Continue rebase, or Abort rebase.",
      };
    if (response.code !== 0)
      return {
        action,
        state: [2, 5, 9].includes(response.code ?? 1) ? "failed" : "uncertain",
        message:
          "gh stack could not rebase this stack. Check that the extension is installed, the checkout is clean and these branches are available here. No push was attempted.",
      };
    if (action === "abort")
      return {
        action,
        state: "aborted",
        message: "gh stack restored the local branches. No push was attempted.",
      };
    if (!allowed())
      return {
        action,
        state: "push_partial",
        message:
          "The local rebase finished, but authorization changed before the push. Inspect the local stack before publishing.",
      };
    started("push");
    const pushed = await this.#runner({
      command: this.#command,
      args: ["stack", "push", "--remote", "origin"],
      mode: "json",
      signal,
    });
    if (pushed.code !== 0)
      return {
        action,
        state: "push_partial",
        message:
          "The local rebase finished but the push did not complete. Some branches may have reached GitHub. Refresh local and host revisions and finish publishing with gh stack push.",
      };
    return {
      action,
      state: "rebased",
      message:
        action === "push"
          ? "gh stack completed the push. Refreshing GitHub revisions."
          : "gh stack completed the rebase and push. Refreshing GitHub revisions.",
    };
  }
}
