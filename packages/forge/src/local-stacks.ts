import { WriteDispatch } from "./write-dispatch.ts";
import {
  ForgeLocalStack,
  type ForgeStack,
  type ForgeStackExpected,
  type ForgeStackOperation,
} from "@ace/protocol/forge-stacks";
import type { CommandRunner } from "./command.ts";
import { redactData } from "./redact.ts";
import { ForgeMutationOutcome } from "./mutation.ts";
import { ForgeError } from "./errors.ts";

import {
  canPublishStack,
  matchesLocalStack,
  matchesStackBranches,
  sameLocalStack,
  stackRebasedLocally,
} from "./stack-plan.ts";
import {
  planStackPublication,
  stackPublishResult,
  type StackPublisher,
  type StackPublishUpdate,
} from "./stack-publish.ts";
export class LocalStacks {
  readonly #runner: CommandRunner;
  readonly #command: string;
  readonly #publish: StackPublisher | undefined;
  constructor(runner: CommandRunner, command = "gh", publish?: StackPublisher) {
    this.#runner = runner;
    this.#command = command;
    this.#publish = publish;
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
    dispatch = new WriteDispatch(),
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
    if (action === "push") return this.#push(expected, current, stack, signal, allowed, dispatch);
    if (!allowed()) throw new ForgeError("forbidden");
    let response;
    try {
      response = await this.#runner({
        command: this.#command,
        args: [
          "stack",
          "rebase",
          ...(action === "rebase" ? ["--remote", "origin"] : [`--${action}`]),
        ],
        mode: "json",
        signal,
        dispatch,
      });
    } catch (error) {
      dispatch.reject(error);
      throw error;
    }
    if (response.identityChanged) throw new ForgeMutationOutcome({ dispatched: true });
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
    return { action, state: "push_partial", message: stackRebasedLocally };
  }
  /**
   * Restack every layer above the checked-out one onto it with gh stack, which owns the saved
   * bases, worktree locks and conflict state; or continue or abort that restack. Never pushes.
   */
  async restack(
    step: "upstack" | "continue" | "abort",
    signal: AbortSignal,
    allowed: () => boolean,
  ): Promise<"restacked" | "conflict" | "failed" | "uncertain"> {
    if (!allowed()) throw new ForgeError("forbidden");
    const response = await this.#runner({
      command: this.#command,
      args: [
        "stack",
        "rebase",
        ...(step === "upstack" ? ["--upstack", "--remote", "origin"] : [`--${step}`]),
      ],
      mode: "json",
      signal,
    });
    if (response.code === 0) return "restacked";
    if (response.code === 3 || response.code === 7) return "conflict";
    return [2, 5, 9].includes(response.code ?? 1) ? "failed" : "uncertain";
  }
  /** One atomic Git push; every layer is leased to the host revision reviewed before rebase. */
  async #push(
    reviewed: ForgeStackExpected,
    local: ForgeLocalStack,
    stack: ForgeStack,
    signal: AbortSignal,
    allowed: () => boolean,
    dispatch: WriteDispatch,
  ): Promise<ForgeStackOperation> {
    if (!this.#publish) throw new ForgeError("unsupported");
    const plan = planStackPublication(reviewed, local, stack);
    if (!plan.ok) throw new ForgeError("conflict");
    if (!allowed()) throw new ForgeError("forbidden");
    let report;
    try {
      report = await this.#publish({
        remote: "origin",
        updates: plan.updates.map((update) => ({
          ref: `refs/heads/${update.branch}`,
          lease: update.lease,
          target: update.target,
        })),
        signal,
        beforeDispatch: () => {
          dispatch.prepare();
          dispatch.record();
        },
      });
    } catch (error) {
      if (!dispatch.dispatched) dispatch.reject();
      throw error;
    }
    return publishOutcome(plan.updates, stackPublishResult(plan.updates, report));
  }
}

function publishOutcome(
  updates: readonly StackPublishUpdate[],
  result: ReturnType<typeof stackPublishResult>,
): ForgeStackOperation {
  const layers = updates.map((update) => `#${update.number}`).join(", ");
  if (result === "published")
    return { action: "push", state: "rebased", message: `Published ${layers} to GitHub.` };
  if (result === "refused")
    return {
      action: "push",
      state: "failed",
      message: `GitHub refused the push, or a layer changed after review. Nothing was published to ${layers}. Bring GitHub's newer commits into the stack, then publish again.`,
    };
  return {
    action: "push",
    state: "uncertain",
    message:
      "Git did not confirm the push. Refresh the stack to compare GitHub with the published revisions. Publishing again is safe; leases stop any overwrite.",
  };
}
