import { readFile } from "node:fs/promises";
import { ClientError, type Client } from "@ace/client";
import { Automation, TriggerVariables, type AutomationResponse } from "@ace/protocol";
import { option, type Args } from "./args.ts";
import { key } from "./mutations.ts";
import { CliFailure, usageFailure } from "./output.ts";

/**
 * `ace automation list|show|run|create|remove` (ADR 0176 §7) over the daemon's automation
 * requests, the same ones the app's Automations page sends.
 */

type Request = Parameters<Client["request"]>[0];

async function ask(
  client: Client,
  request: Request & { type: `automation.${string}` },
  signal: AbortSignal,
  requestId?: string,
): Promise<AutomationResponse> {
  const response = await client.request(request, { signal, ...(requestId ? { requestId } : {}) });
  if (response.type !== "automation.result")
    throw new CliFailure("uncertain", "The daemon gave no automation answer.");
  if (!response.ok)
    throw new CliFailure("refused", response.error ?? "ace refused it.", undefined, {
      code: /not found|unknown automation/i.test(response.error ?? "") ? "not_found" : "refused",
      hint: "See your automations with ace automation list.",
    });
  return response;
}

export function listAutomations(client: Client, signal: AbortSignal) {
  return ask(client, { type: "automation.list" }, signal);
}

/** One automation and its schedule, from the list; not found is a refusal naming the list. */
export async function showAutomation(client: Client, signal: AbortSignal, id: string) {
  const response = await listAutomations(client, signal);
  const automation = response.automations?.find((candidate) => candidate.id === id);
  if (!automation)
    throw new CliFailure("refused", `ace has no automation ${id}.`, undefined, {
      code: "not_found",
      argument: "AUTOMATION",
      hint: "See your automations with ace automation list.",
    });
  const schedules = (response.schedules ?? []).filter((schedule) => schedule.id === id);
  return { ...response, automations: [automation], schedules };
}

/**
 * `--variables @FILE` reads a JSON object of strings from a file; the first CLI's inline JSON
 * still works in the window. `readFile` is the only effect.
 */
export async function automationVariables(
  raw: string | undefined,
  readText: (path: string) => Promise<string>,
): Promise<TriggerVariables> {
  if (raw === undefined) return {};
  const path = raw.startsWith("@") ? raw.slice(1) : undefined;
  let text = raw;
  if (path !== undefined)
    try {
      text = await readText(path);
    } catch {
      throw usageFailure(`Couldn't read ${path} for --variables.`, { argument: "--variables" });
    }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw usageFailure(
      `--variables needs a JSON object${path ? `, and ${path} isn't JSON` : ""}.`,
      {
        argument: "--variables",
        hint: 'Write them in a file, like {"branch": "main"}, and pass --variables @FILE.',
      },
    );
  }
  const parsed = TriggerVariables.safeParse(value);
  if (parsed.success) return parsed.data;
  throw usageFailure("--variables must map names to text, at most 64 of them.", {
    argument: "--variables",
    hint: 'Names start with a letter, like {"branch": "main"}.',
  });
}

/** The receipt of a mutation that might not have run: retried with its key, it runs once. */
async function admitted<T>(
  id: string,
  automationId: string,
  run: () => Promise<T>,
  signal: AbortSignal,
) {
  try {
    return await run();
  } catch (error) {
    if (signal.aborted || error instanceof ClientError)
      throw new CliFailure(
        "uncertain",
        "ace didn't confirm the automation request, so it may or may not have run.",
        { automationId, idempotencyKey: id },
        { code: "uncertain", idempotencyKey: id },
      );
    throw error;
  }
}

export async function runAutomation(args: Args, client: Client, signal: AbortSignal, id: string) {
  const idempotencyKey = key(args);
  const variables = await automationVariables(option(args, "variables"), (path) =>
    readFile(path, "utf8"),
  );
  const message = option(args, "message");
  const response = await admitted(
    idempotencyKey,
    id,
    () =>
      ask(
        client,
        { type: "automation.run", id, variables, ...(message ? { message } : {}) },
        signal,
        idempotencyKey,
      ),
    signal,
  );
  return { ...response, idempotencyKey, automationId: id };
}

/** `ace automation create @FILE`: an automation definition as JSON, as the app saves it. */
export async function createAutomation(
  args: Args,
  client: Client,
  signal: AbortSignal,
  file: string,
) {
  const path = file.startsWith("@") ? file.slice(1) : file;
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw usageFailure(`${path} must be a readable JSON file.`, {
      argument: "DEFINITION",
      hint: "Write the automation as JSON, then pass it as @FILE.",
    });
  }
  const parsed = Automation.safeParse(value);
  if (!parsed.success)
    throw usageFailure(
      `${path} isn't an automation: ${parsed.error.issues[0]?.path.join(".") || "its fields"} ${parsed.error.issues[0]?.message ?? "is wrong"}.`,
      { argument: "DEFINITION", hint: "See an existing one with ace automation show ID --json." },
    );
  const idempotencyKey = key(args);
  const automation = parsed.data;
  const response = await admitted(
    idempotencyKey,
    automation.id,
    () =>
      ask(
        client,
        { type: "automation.put", automation, expectedRevision: null },
        signal,
        idempotencyKey,
      ),
    signal,
  );
  return { ...response, idempotencyKey, automationId: automation.id };
}

export async function removeAutomation(
  args: Args,
  client: Client,
  signal: AbortSignal,
  id: string,
) {
  const idempotencyKey = key(args);
  const response = await admitted(
    idempotencyKey,
    id,
    () => ask(client, { type: "automation.remove", id }, signal, idempotencyKey),
    signal,
  );
  return { ...response, idempotencyKey, automationId: id };
}
