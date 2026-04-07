import path from "node:path";

import {
  CopilotClient,
  type AssistantMessageEvent,
  type GetAuthStatusResponse,
  type GetStatusResponse,
  type MessageOptions,
  type ModelInfo,
  type ResumeSessionConfig,
  type SessionConfig,
  type SessionEventHandler,
} from "@github/copilot-sdk";
import type {
  GitHubCopilotModelOptions,
  ModelCapabilities,
  ServerProviderModel,
} from "@ace/contracts";
import { normalizeGitHubCopilotModelOptionsWithCapabilities } from "@ace/shared/model";
import { Effect } from "effect";

import { runProcess } from "../processRunner.ts";

const GITHUB_COPILOT_CLI_LOOKUP_TIMEOUT_MS = 10_000;
const GITHUB_COPILOT_CLI_STOP_TIMEOUT_MS = 5_000;

export interface GitHubCopilotClientConfig {
  readonly cliUrl?: string;
}

export interface GitHubCopilotSessionClient {
  readonly sessionId: string;
  on(handler: SessionEventHandler): () => void;
  disconnect(): Promise<void>;
  send(options: MessageOptions): Promise<string>;
  sendAndWait(
    options: MessageOptions,
    timeout?: number,
  ): Promise<AssistantMessageEvent | undefined>;
  abort(): Promise<void>;
}

export interface GitHubCopilotClientLike {
  getStatus(): Promise<GetStatusResponse>;
  getAuthStatus(): Promise<GetAuthStatusResponse>;
  listModels(): Promise<ReadonlyArray<ModelInfo>>;
  createSession(config: SessionConfig): Promise<GitHubCopilotSessionClient>;
  resumeSession(
    sessionId: string,
    config: ResumeSessionConfig,
  ): Promise<GitHubCopilotSessionClient>;
  stop(): Promise<ReadonlyArray<Error>>;
  forceStop(): Promise<void>;
}

export interface GitHubCopilotClientShutdownResult {
  readonly stopped: boolean;
  readonly forced: boolean;
  readonly errors: ReadonlyArray<Error>;
}

type TimedPromiseOutcome<T> =
  | { readonly kind: "resolved"; readonly value: T }
  | { readonly kind: "rejected"; readonly error: unknown }
  | { readonly kind: "timeout" };

function isExplicitCliPath(binaryPath: string): boolean {
  return path.isAbsolute(binaryPath) || binaryPath.includes("/") || binaryPath.includes("\\");
}

function toReasoningEffortLabel(value: string): string {
  switch (value) {
    case "xhigh":
      return "Extra High";
    case "high":
      return "High";
    case "medium":
      return "Medium";
    case "low":
      return "Low";
    default:
      return value;
  }
}

export function isGitHubCopilotCliMissingError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const lower = error.message.toLowerCase();
  return (
    lower.includes("enoent") ||
    lower.includes("command not found") ||
    lower.includes("copilot cli not found")
  );
}

export async function resolveGitHubCopilotCliPath(binaryPath: string): Promise<string> {
  const trimmedBinaryPath = binaryPath.trim();
  if (trimmedBinaryPath.length === 0) {
    throw new Error("spawn copilot ENOENT");
  }
  if (isExplicitCliPath(trimmedBinaryPath)) {
    return trimmedBinaryPath;
  }

  const lookupCommand = process.platform === "win32" ? "where" : "which";
  const result = await runProcess(lookupCommand, [trimmedBinaryPath], {
    allowNonZeroExit: true,
    timeoutMs: GITHUB_COPILOT_CLI_LOOKUP_TIMEOUT_MS,
    outputMode: "truncate",
  });

  const resolvedPath = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (result.timedOut || result.code !== 0 || !resolvedPath) {
    throw new Error(`spawn ${trimmedBinaryPath} ENOENT`);
  }

  return resolvedPath;
}

export async function createGitHubCopilotClient(
  binaryPath: string,
  config?: GitHubCopilotClientConfig,
): Promise<GitHubCopilotClientLike> {
  const configuredCliUrl = config?.cliUrl?.trim();
  const envCliUrl = process.env.ACE_GITHUB_COPILOT_CLI_URL?.trim();
  const cliUrl = configuredCliUrl && configuredCliUrl.length > 0 ? configuredCliUrl : envCliUrl;
  const client =
    cliUrl && cliUrl.length > 0
      ? new CopilotClient({ cliUrl, useStdio: false })
      : new CopilotClient({ cliPath: await resolveGitHubCopilotCliPath(binaryPath) });
  await client.start();
  return client;
}

function toError(cause: unknown, fallback: string): Error {
  return cause instanceof Error ? cause : new Error(`${fallback}: ${String(cause)}`);
}

function withTimeoutOutcome<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<TimedPromiseOutcome<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: TimedPromiseOutcome<T>) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      resolve(outcome);
    };

    const timeoutId = setTimeout(() => {
      finish({ kind: "timeout" });
    }, timeoutMs);
    timeoutId.unref?.();

    promise.then(
      (value) => finish({ kind: "resolved", value }),
      (error) => finish({ kind: "rejected", error }),
    );
  });
}

export async function stopGitHubCopilotClient(
  client: GitHubCopilotClientLike,
  options?: { readonly timeoutMs?: number },
): Promise<GitHubCopilotClientShutdownResult> {
  const timeoutMs = options?.timeoutMs ?? GITHUB_COPILOT_CLI_STOP_TIMEOUT_MS;
  const errors: Error[] = [];
  let forced = false;

  const stopOutcome = await withTimeoutOutcome(client.stop(), timeoutMs);
  if (stopOutcome.kind === "resolved") {
    errors.push(...stopOutcome.value);
    if (stopOutcome.value.length === 0) {
      return {
        stopped: true,
        forced: false,
        errors,
      };
    }
    forced = true;
  } else if (stopOutcome.kind === "rejected") {
    forced = true;
    errors.push(toError(stopOutcome.error, "Failed to stop GitHub Copilot client"));
  } else {
    forced = true;
    errors.push(
      new Error(`Timed out stopping GitHub Copilot client after ${String(timeoutMs)}ms.`),
    );
  }

  const forceStopOutcome = await withTimeoutOutcome(client.forceStop(), timeoutMs);
  if (forceStopOutcome.kind === "resolved") {
    return {
      stopped: true,
      forced,
      errors,
    };
  }

  errors.push(
    forceStopOutcome.kind === "rejected"
      ? toError(forceStopOutcome.error, "Failed to force stop GitHub Copilot client")
      : new Error(`Timed out force stopping GitHub Copilot client after ${String(timeoutMs)}ms.`),
  );

  return {
    stopped: false,
    forced,
    errors,
  };
}

export function getGitHubCopilotModelCapabilities(model: ModelInfo): ModelCapabilities {
  return {
    reasoningEffortLevels:
      model.supportedReasoningEfforts?.map((effort) => ({
        value: effort,
        label: toReasoningEffortLabel(effort),
        ...(model.defaultReasoningEffort === effort ? { isDefault: true } : {}),
      })) ?? [],
    supportsFastMode: false,
    supportsThinkingToggle: false,
    contextWindowOptions: [],
    promptInjectedEffortLevels: [],
  };
}

export function toGitHubCopilotServerProviderModel(model: ModelInfo): ServerProviderModel {
  return {
    slug: model.id,
    name: model.name,
    isCustom: false,
    capabilities: getGitHubCopilotModelCapabilities(model),
  };
}

export function normalizeGitHubCopilotModelOptionsForModel(
  model: ModelInfo | null | undefined,
  options: GitHubCopilotModelOptions | null | undefined,
): GitHubCopilotModelOptions | undefined {
  if (!model) {
    return undefined;
  }
  return normalizeGitHubCopilotModelOptionsWithCapabilities(
    getGitHubCopilotModelCapabilities(model),
    options,
  );
}

export interface GitHubCopilotSdkProbe {
  readonly version: string | null;
  readonly auth: GetAuthStatusResponse | null;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly issues: ReadonlyArray<string>;
}

export async function probeGitHubCopilotSdk(
  binaryPath: string,
  config?: GitHubCopilotClientConfig,
): Promise<GitHubCopilotSdkProbe> {
  const client = await createGitHubCopilotClient(binaryPath, config);
  try {
    const [statusResult, authResult, modelsResult] = await Promise.allSettled([
      client.getStatus(),
      client.getAuthStatus(),
      client.listModels(),
    ]);

    const issues: string[] = [];
    if (statusResult.status === "rejected") {
      issues.push(
        statusResult.reason instanceof Error
          ? statusResult.reason.message
          : String(statusResult.reason),
      );
    }
    if (authResult.status === "rejected") {
      issues.push(
        authResult.reason instanceof Error ? authResult.reason.message : String(authResult.reason),
      );
    }
    if (modelsResult.status === "rejected") {
      issues.push(
        modelsResult.reason instanceof Error
          ? modelsResult.reason.message
          : String(modelsResult.reason),
      );
    }

    return {
      version: statusResult.status === "fulfilled" ? statusResult.value.version : null,
      auth: authResult.status === "fulfilled" ? authResult.value : null,
      models:
        modelsResult.status === "fulfilled"
          ? modelsResult.value.map(toGitHubCopilotServerProviderModel)
          : [],
      issues,
    };
  } finally {
    const shutdown = await stopGitHubCopilotClient(client).catch((cause) => ({
      stopped: false,
      forced: false,
      errors: [toError(cause, "Failed to stop GitHub Copilot client")],
    }));
    if (!shutdown.stopped || shutdown.errors.length > 0) {
      await Effect.runPromise(
        Effect.logWarning("Failed to fully stop GitHub Copilot client.", {
          stopped: shutdown.stopped,
          forced: shutdown.forced,
          errors: shutdown.errors.map((error) => error.message),
        }),
      );
    }
  }
}
