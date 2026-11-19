import { agentShell, personOnlyRefusal } from "../person-gate.ts";
import { InteractionId, type CliOpenRequest, type InteractionResolution } from "@ace/protocol";
import type { Client } from "@ace/client";
import { prompt } from "../io.ts";
import { command, key } from "../mutations.ts";
import { withSession, type CommandContext } from "../run/context.ts";
import { requestListLines, requestShowLines } from "../render/request.ts";
import { allowResolution, answerResolution, denyResolution } from "./answers.ts";
import { projectNames, readProjects, readRequests, resolveThread } from "./daemon.ts";
import { colourOn, receipt, show, stringFlag } from "./output.ts";
import { askQuestions, missing, pickRequest } from "./pick.ts";
import { requestNoun, resolveRef } from "./refs.ts";

/** The open requests a command chooses from: one thread's tree with `--thread`, else all. */
async function openList(context: CommandContext, client: Client, signal: AbortSignal) {
  const thread = stringFlag(context.args, "thread");
  const threadId = thread ? await resolveThread(client, signal, thread) : undefined;
  return readRequests(client, signal, threadId);
}

/** The request named by REQUEST (or `--request`), or the one picked (ADR 0178 §9). */
async function chosen(
  context: CommandContext,
  client: Client,
  signal: AbortSignal,
  usage: string,
): Promise<CliOpenRequest> {
  requireRequest(context, usage);
  const list = await openList(context, client, signal);
  const given = context.args.words[0] ?? stringFlag(context.args, "request");
  if (given === undefined) return pickRequest(context.args, list.requests, usage);
  const id = resolveRef(
    given,
    list.requests.map((each) => each.interaction.id),
    requestNoun,
  );
  const found = list.requests.find((each) => each.interaction.id === id);
  if (!found) throw new Error(`request ${id} vanished from its own list`);
  return found;
}

/** Off a terminal, a missing REQUEST is a usage error before anything is read (ADR 0178 §9). */
function requireRequest(context: CommandContext, usage: string): void {
  const { args } = context;
  if (args.interactive || args.words[0] !== undefined) return;
  if (stringFlag(args, "request") !== undefined || stringFlag(args, "thread") !== undefined) return;
  throw missing(
    usage,
    "REQUEST",
    `Pass a request id: ${usage} REQUEST. See them with ace request list.`,
  );
}

export async function requestList(context: CommandContext): Promise<void> {
  return withSession(context, context.args, async ({ client, signal }) => {
    const list = await openList(context, client, signal);
    const names = projectNames(await readProjects(client, signal).catch(() => []));
    const now = Date.now();
    await show(context.args, list, {
      human: (value) =>
        requestListLines(value, { now, colour: colourOn(context), projectNames: names }),
      quiet: (value) => value.requests.map((each) => each.interaction.id),
    });
  });
}

export async function requestShow(context: CommandContext): Promise<void> {
  requireRequest(context, "ace request show");
  return withSession(context, context.args, async ({ client, signal }) => {
    const open = await chosen(context, client, signal, "ace request show");
    await show(context.args, open, {
      human: (value) => requestShowLines(value, colourOn(context)),
      quiet: (value) => [value.interaction.id],
    });
  });
}

/**
 * Sends the person's reply. An affirmative reply to a request too large to send whole is
 * made only after reading it whole, under the version read (ADR 0157).
 */
async function resolveWith(
  context: CommandContext,
  client: Client,
  signal: AbortSignal,
  open: CliOpenRequest,
  resolution: InteractionResolution,
  done: string,
  verb: "allow" | "deny" | "answer",
): Promise<void> {
  // Only a person at a terminal answers, and they type the word (ADR 0178 §12.5); main.ts
  // refused everyone else before this ran, and this holds for any other caller too.
  const refused = personOnlyRefusal("answer", {
    agent: agentShell(context.env),
    interactive: context.args.interactive === true,
  });
  if (refused) throw refused;
  const { askTyped } = await import("../ask.ts");
  await askTyped(`${open.threadTitle}: ${requestTitle(open)}. Type ${verb} to ${verb} it.`, verb);
  const affirmative =
    (resolution.kind === "approval" &&
      open.interaction.request.kind === "approval" &&
      open.interaction.request.options.some(
        (option) => option.id === resolution.optionId && option.kind.startsWith("allow_"),
      )) ||
    (resolution.kind === "plan_review" && resolution.decision === "approve") ||
    (resolution.kind === "question" && !resolution.dismissed) ||
    (resolution.kind === "elicitation" && resolution.action === "accept");
  const readWhole =
    affirmative && open.interaction.truncated
      ? (
          await client.readInteraction(
            { threadId: open.threadId, interactionId: open.interaction.id },
            { signal },
          )
        ).version
      : undefined;
  const sent = await command(
    client,
    {
      type: "interaction.resolve",
      interactionId: InteractionId.parse(open.interaction.id),
      resolution,
      ...(readWhole ? { readWhole } : {}),
    },
    key(context.args),
    signal,
  );
  await receipt(context.args, { ...sent, requestId: open.interaction.id }, () => done);
}

export async function requestAllow(context: CommandContext): Promise<void> {
  requireRequest(context, "ace request allow");
  return withSession(context, context.args, async ({ client, signal }) => {
    const open = await chosen(context, client, signal, "ace request allow");
    const resolution = allowResolution(open.interaction, {
      always: context.args.flags.always === true,
      option: stringFlag(context.args, "option"),
    });
    await resolveWith(context, client, signal, open, resolution, "Allowed.", "allow");
  });
}

export async function requestDeny(context: CommandContext): Promise<void> {
  requireRequest(context, "ace request deny");
  return withSession(context, context.args, async ({ client, signal }) => {
    const open = await chosen(context, client, signal, "ace request deny");
    const resolution = denyResolution(open.interaction, {
      option: stringFlag(context.args, "option"),
      feedback: stringFlag(context.args, "feedback"),
    });
    await resolveWith(context, client, signal, open, resolution, "Denied.", "deny");
  });
}

export async function requestAnswer(context: CommandContext): Promise<void> {
  requireRequest(context, "ace request answer");
  return withSession(context, context.args, async ({ client, signal }) => {
    const open = await chosen(context, client, signal, "ace request answer");
    const given = context.args.lists?.choice ?? [];
    const text = context.args.words[1] !== undefined ? await prompt(context.args, 1) : undefined;
    const choices =
      context.args.interactive && text === undefined
        ? await askQuestions(open.interaction, given)
        : [...given];
    const resolution = answerResolution(open.interaction, { text, choices });
    await resolveWith(context, client, signal, open, resolution, "Answered.", "answer");
  });
}

/** The request's own words, short: its title, or the first question. */
function requestTitle(open: CliOpenRequest): string {
  const request = open.interaction.request;
  const title =
    request.kind === "question"
      ? (request.questions[0]?.text ?? "A question")
      : "title" in request && typeof request.title === "string"
        ? request.title
        : request.kind.replace("_", " ");
  return title.length > 120 ? `${title.slice(0, 117)}…` : title;
}
