import { setTimeout as delay } from "node:timers/promises";
import type { Client } from "@ace/client";
import { ProviderKind, type ProviderLoginProgress } from "@ace/protocol";
import { manualLogin } from "../provider-login-driver.ts";
import { option, type Args } from "./args.ts";
import { emit, print } from "./io.ts";
import { CliFailure, exitCodes, usageFailure } from "./output.ts";
import { loginPrompt, loginStep } from "./provider-login-steps.ts";
import { modelIds, modelListLines } from "./render/model.ts";
import {
  capabilitiesLines,
  providerListLines,
  providerName,
  providerShowLines,
} from "./render/provider.ts";

/** The provider CLIs ace drives, their sign-in and their models (ADR 0176 §7). */

const refusals: Readonly<Record<string, string>> = {
  forbidden: "This connection can't manage providers.",
  unavailable: "Providers aren't available on this daemon right now.",
  busy: "Another sign-in for this provider is running. Finish or cancel it first.",
  not_found: "That provider or account isn't on this machine.",
  invalid_input: "The provider didn't take that answer.",
};

function refused(code: string): CliFailure {
  return new CliFailure("refused", refusals[code] ?? `The daemon refused: ${code}.`, undefined, {
    code: code === "busy" ? "busy" : code === "not_found" ? "not_found" : "refused",
    hint: "See their state with ace provider list.",
  });
}

async function listProviders(client: Client, signal: AbortSignal) {
  const response = await client.request(
    { type: "providers.request", operation: "list" },
    { signal },
  );
  if (!response.result.ok) throw refused(response.result.error);
  return response.result;
}

export async function providerList(args: Args, client: Client, signal: AbortSignal) {
  const value = await listProviders(client, signal);
  return emit(args, value, {
    human: providerListLines,
    quiet: (list) => list.providers.map((status) => status.provider),
  });
}

/** A provider name as typed, or the sentence naming the ones there are. */
export function providerArgument(word: string | undefined): ProviderKind {
  const parsed = ProviderKind.safeParse(word?.trim().toLowerCase());
  if (parsed.success && parsed.data !== "acp") return parsed.data;
  throw usageFailure(`PROVIDER must be codex, claude, cursor, opencode, antigravity or pi.`, {
    argument: "PROVIDER",
    hint: "See the providers with ace provider list.",
  });
}

export async function providerShow(args: Args, client: Client, signal: AbortSignal) {
  const provider = providerArgument(args.words[0]);
  const { providers } = await listProviders(client, signal);
  const status = providers.find((entry) => entry.provider === provider);
  if (!status)
    throw new CliFailure("refused", `${providerName(provider)} isn't on this machine.`, undefined, {
      code: "not_found",
      hint: "See the providers ace found with ace provider list.",
    });
  return emit(args, status, { human: providerShowLines, quiet: (value) => [value.provider] });
}

export async function capabilities(args: Args, client: Client, signal: AbortSignal) {
  const { providers } = await listProviders(client, signal);
  const models = await client.request(
    { type: "models.list", options: { offset: 0, limit: 100 } },
    { signal },
  );
  const permissions = [];
  for (const provider of providers)
    permissions.push({
      provider: provider.provider,
      result: await client.request(
        { type: "permissions.capabilities", provider: provider.provider },
        { signal },
      ),
    });
  const tools = await client.request(
    { type: "cli.request", operation: { op: "capabilities" } },
    { signal },
  );
  const value = { providers, models: models.result, permissions, tools: tools.result };
  return emit(args, value, {
    human: capabilitiesLines,
    quiet: (all) => all.providers.map((status) => status.provider),
  });
}

export async function modelList(args: Args, client: Client, signal: AbortSignal) {
  const provider = option(args, "provider");
  const instance = option(args, "account");
  const limit = option(args, "limit");
  const size = limit === undefined ? 100 : Number(limit);
  if (!Number.isInteger(size) || size < 1 || size > 100)
    throw usageFailure("--limit takes a whole number from 1 to 100.", { argument: "--limit" });
  const response = await client.request(
    {
      type: "models.list",
      options: {
        offset: 0,
        limit: size,
        ...(provider ? { provider: providerArgument(provider) } : {}),
        ...(instance ? { instance } : {}),
      },
    },
    { signal },
  );
  const result = response.result;
  if (!("models" in result))
    throw new CliFailure("refused", "The daemon didn't list models.", undefined, {
      hint: "See the providers with ace provider list.",
    });
  return emit(args, result, { human: modelListLines, quiet: modelIds });
}

/** How the login loop talks to a person: questions, and lines on stderr. */
export interface LoginTerminal {
  choose(choices: readonly { id: string; label: string }[]): Promise<string>;
  progress(lines: readonly string[]): void;
}

const processTerminal: LoginTerminal = {
  async choose(choices) {
    const { askSelect } = await import("./ask.ts");
    return askSelect(
      "Which service should it connect?",
      choices.map((choice) => ({ value: choice.id, label: choice.label })),
    );
  },
  progress(lines) {
    if (lines.length) process.stderr.write(`${lines.join("\n")}\n`);
  },
};

/**
 * `ace provider login PROVIDER`: drives the provider's own sign-in through the daemon until it
 * finishes, or stops where the person must act (exit 2). The session is always released.
 */
export async function providerLogin(
  args: Args,
  client: Client,
  signal: AbortSignal,
  terminal: LoginTerminal = processTerminal,
) {
  const provider = providerArgument(args.words[0]);
  const instance = option(args, "account") ?? option(args, "instance");
  const name = providerName(provider);
  const stream = args.flags.stream === "jsonl";
  let response = await client.request(
    { type: "provider.login.start", provider, instance, method: "login" },
    { signal },
  );
  let previous = -1;
  let session: string | undefined;
  let released = false;
  const release = async () => {
    if (!session || released) return;
    released = true;
    const cancelled = await client
      .request({ type: "provider.login.cancel", session }, { signal: AbortSignal.timeout(5000) })
      .catch(() => undefined);
    if (
      !cancelled?.result.ok ||
      !["cancelled", "failed", "succeeded"].includes(cancelled.result.progress.state)
    )
      throw new CliFailure(
        "uncertain",
        `${name} sign-in may still be running in the daemon.`,
        { session },
        { hint: `Run ace provider login ${provider} again to take it over or start fresh.` },
      );
  };
  try {
    while (true) {
      if (!response.result.ok) throw refused(response.result.error);
      const progress: ProviderLoginProgress = response.result.progress;
      session = progress.session;
      if (progress.sequence !== previous) {
        previous = progress.sequence;
        if (stream) await print(args, { type: "login", progress });
        else terminal.progress(loginPrompt(progress, name));
      }
      const step = loginStep(
        progress,
        { choice: option(args, "choice"), interactive: args.interactive === true },
        name,
      );
      if (step.kind === "done") {
        released = true;
        return emit(
          args,
          { provider, status: "ok" as const },
          { human: () => `${name} is signed in.`, quiet: () => [] },
        );
      }
      if (step.kind === "stop") {
        await release();
        const manual =
          progress.manual ??
          (provider === "cursor" ? undefined : manualLogin(provider, "login", instance));
        const value = { ...progress, ...(manual ? { manual } : {}), sessionReleased: true };
        if (args.flags.json || args.flags.jq || stream) {
          await print(args, value);
          process.exitCode = exitCodes[step.outcome];
          return;
        }
        throw new CliFailure(step.outcome, step.message, undefined, {
          code: step.outcome === "needs-human" ? "needs_human" : "failed",
          ...(step.hint ? { hint: step.hint } : manual ? { hint: manual.instruction } : {}),
        });
      }
      if (step.kind === "send" || step.kind === "choose") {
        const input =
          step.kind === "send" ? step.input : { choice: await terminal.choose(step.choices) };
        response = await client.request(
          { type: "provider.login.input", session: progress.session, input },
          { signal },
        );
        continue;
      }
      await delay(250, undefined, { signal });
      response = await client.request(
        { type: "provider.login.poll", session: progress.session },
        { signal },
      );
    }
  } finally {
    await release();
  }
}
