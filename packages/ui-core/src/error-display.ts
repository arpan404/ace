import type { ProviderKind } from "@ace/protocol";
import { providerNames } from "./providers.ts";

/*
 * Provider failures in words (IR-12): "Claude Code doesn't recognise the model “opus-5.5”"
 * with the action that fixes it, never "[claude-code:unrecognized_model] {json}" or a bare
 * "model_not_found". Pure.
 */

export type ErrorAction = "change_model" | "sign_in" | "switch_account" | "retry";

export interface ErrorView {
  /** One line, in words. */
  title: string;
  /** A second line when the title alone isn't the whole story. */
  message?: string | undefined;
  action?: ErrorAction | undefined;
  /** The provider's own text, for "Details". */
  raw?: string | undefined;
  code?: string | undefined;
}

export interface ErrorInput {
  /** The notice or error text as the provider gave it. */
  text: string;
  code?: string | undefined;
  title?: string | undefined;
  detail?: string | undefined;
  provider?: ProviderKind | undefined;
  model?: string | undefined;
  /** The failure's kind on `AgentStatus.failed`. */
  kind?: string | undefined;
}

const providerIds: Record<string, ProviderKind> = {
  "claude-code": "claude",
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
  cursor: "cursor",
  pi: "pi",
  acp: "acp",
  antigravity: "antigravity",
};

/** "[claude-code:unrecognized_model] {"model":"opus-5.5"}" → its provider, code and payload. */
export function parseTaggedError(text: string):
  | {
      provider?: ProviderKind | undefined;
      code: string;
      payload?: Record<string, unknown> | undefined;
      rest: string;
    }
  | undefined {
  const match = /^\s*\[([\w-]+):([\w.-]+)\]\s*(.*)$/s.exec(text);
  if (!match) return undefined;
  const rest = match[3] ?? "";
  let payload: Record<string, unknown> | undefined;
  const json = /^[{]/.test(rest.trim()) ? rest.trim() : undefined;
  if (json)
    try {
      const parsed: unknown = JSON.parse(json);
      if (typeof parsed === "object" && parsed !== null)
        payload = parsed as Record<string, unknown>;
    } catch {
      /* Not JSON after all: it stays in `rest`. */
    }
  return { provider: providerIds[match[1]!], code: match[2]!, payload, rest };
}

const codeAliases: Record<string, string> = {
  unrecognized_model: "model_not_found",
  unknown_model: "model_not_found",
  invalid_model: "model_not_found",
  model_not_found: "model_not_found",
  not_signed_in: "auth",
  unauthenticated: "auth",
  unauthorized: "auth",
  authentication_failed: "auth",
  auth: "auth",
  usage_limit: "quota",
  quota_exceeded: "quota",
  insufficient_quota: "quota",
  quota: "quota",
  rate_limited: "rate_limit",
  rate_limit: "rate_limit",
  rate_limit_exceeded: "rate_limit",
  network: "network",
  network_error: "network",
  connection_error: "network",
  process_exit: "process_exit",
  context_length: "context_length",
  context_length_exceeded: "context_length",
  context_window_exceeded: "context_length",
};

const bareCode = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

/** True for a notice that is only a code ("model_not_found"), the echo of an error just shown. */
export function isBareErrorCode(text: string): boolean {
  return bareCode.test(text.trim());
}

/** A failure as one readable row: title, the fixing action and the raw text behind "Details". */
export function describeProviderError(input: ErrorInput): ErrorView {
  const tagged = parseTaggedError(input.text);
  const rawCode =
    input.code ?? tagged?.code ?? (isBareErrorCode(input.text) ? input.text.trim() : undefined);
  const code = rawCode ? (codeAliases[rawCode] ?? rawCode) : input.kind && codeAliases[input.kind];
  const provider = input.provider ?? tagged?.provider;
  const who = provider ? providerNames[provider] : "The provider";
  const model =
    input.model ??
    (typeof tagged?.payload?.["model"] === "string" ? tagged.payload["model"] : undefined);
  const raw = input.detail ?? (input.text.trim() || undefined);
  const plain =
    tagged && !tagged.payload && tagged.rest.trim()
      ? tagged.rest.trim()
      : tagged
        ? undefined
        : input.text.trim();
  const message = (text: string | undefined) => {
    const line = text?.split("\n")[0]?.trim();
    return line && line !== input.title ? line : undefined;
  };
  switch (code) {
    case "model_not_found":
      return {
        title: model
          ? `${who} doesn't recognise the model “${model}”`
          : `${who} doesn't recognise the model`,
        action: "change_model",
        raw,
        code,
      };
    case "auth":
      return {
        title: `Not signed in to ${provider ? providerNames[provider] : "the provider"}`,
        action: "sign_in",
        raw,
        code,
      };
    case "quota":
      return {
        title: "Usage limit reached",
        message: message(plain),
        action: "switch_account",
        raw,
        code,
      };
    case "rate_limit":
      return { title: "Rate limited", message: message(plain), action: "retry", raw, code };
    case "network":
      return { title: "Network trouble", message: message(plain), action: "retry", raw, code };
    case "process_exit":
      return {
        title: `${who} stopped unexpectedly`,
        message: message(plain),
        action: "retry",
        raw,
        code,
      };
    case "context_length":
      return {
        title: "The conversation is too long for the model",
        message: message(plain),
        raw,
        code,
      };
    default: {
      const title =
        input.title ?? message(plain) ?? (rawCode ? sentence(rawCode) : "Something went wrong");
      return { title, message: input.title ? message(plain) : undefined, raw, code: rawCode };
    }
  }
}

function sentence(code: string): string {
  const words = code.replace(/[_-]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : code;
}

/** The parts of a notice an echo check reads; structured fields are read when present. */
interface NoticeLike {
  type: string;
  level?: string;
  text?: string;
  agentId?: string | undefined;
  runId?: string | undefined;
}

const noticeCode = (notice: NoticeLike) => {
  const record = notice as unknown as Record<string, unknown>;
  const details = record["details"];
  const code =
    typeof record["code"] === "string"
      ? record["code"]
      : typeof details === "object" && details !== null && "code" in details
        ? String(details.code)
        : undefined;
  return describeProviderError({ text: notice.text ?? "", code }).code;
};

/**
 * True when the notice at `index` is only the code of the error just before it (IR-12): the
 * provider reported one failure twice, as text and as a bare code. It must be the same failure
 * (same code), from the same agent and run, with no work between them; any other bare code is
 * its own failure and shows.
 */
export function echoesEarlierError(
  order: readonly string[],
  index: number,
  item: (id: string) => NoticeLike | undefined,
  span = 3,
): boolean {
  const echo = item(order[index] ?? "");
  if (echo?.type !== "notice" || !isBareErrorCode(echo.text ?? "")) return false;
  const code = noticeCode(echo);
  for (let at = index - 1; at >= Math.max(0, index - span); at--) {
    const earlier = item(order[at] ?? "");
    if (!earlier) continue;
    if (earlier.type !== "notice") return false;
    if (earlier.level !== "error") continue;
    return (
      earlier.agentId === echo.agentId &&
      earlier.runId === echo.runId &&
      !isBareErrorCode(earlier.text ?? "") &&
      noticeCode(earlier) === code
    );
  }
  return false;
}
