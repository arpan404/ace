import { WriteDispatch, type GitHubInbox } from "@ace/forge";
import type { Command, CommandResult, ForgeInboxAction, ForgeInboxCommand } from "@ace/protocol";
import { actionErrorCode } from "./action-errors.ts";
import { commandNotDispatched } from "./command-not-dispatched.ts";

/**
 * One inbox write. The account is checked before dispatch and the device's authority just
 * before it; a write that may have reached GitHub is reported uncertain, never retried. Each
 * write sets a state (read, done, unsubscribed), so the person may safely send it again.
 */
export async function runInboxWrite(
  command: Command & { payload: ForgeInboxCommand },
  inbox: () => Promise<GitHubInbox>,
  allowed: () => boolean,
  signal: AbortSignal,
): Promise<Omit<CommandResult, "commandId">> {
  const input = command.payload.input;
  if (!allowed()) return commandNotDispatched(command, "forbidden");
  let target: GitHubInbox;
  try {
    target = await inbox();
  } catch (error) {
    return commandNotDispatched(command, actionErrorCode(error));
  }
  const dispatch = new WriteDispatch(() => {
    signal.throwIfAborted();
    if (!allowed()) throw new Error("forbidden");
  });
  try {
    await target.write(input, signal, dispatch);
    const action: ForgeInboxAction = { id: command.id, state: "succeeded", action: input.action };
    return { ok: true, inboxAction: action };
  } catch (error) {
    const code = actionErrorCode(error);
    const state = dispatch.definitelyFailed ? "failed" : "uncertain";
    return {
      ok: false,
      error: state === "uncertain" ? "action_outcome_uncertain" : code,
      inboxAction: { id: command.id, state, action: input.action, error: code },
    };
  }
}
