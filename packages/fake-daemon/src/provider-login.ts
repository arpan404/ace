import { fakeApiKeySupport } from "./provider-auth-support.ts";
import { ProviderLoginRequest, ProviderLoginProgress, OnboardingRequest } from "@ace/protocol";
import { onboardingChecklist, providerReadiness } from "@ace/core";
import type { ClientMessage, ProviderKind, ProviderStatus, ServerMessage } from "@ace/protocol";

type Scenario = "device_code" | "browser" | "choice" | "failure";
interface Job {
  owner: string;
  requestId: string;
  progress: ProviderLoginProgress;
  scenario: Scenario;
  terminalOwner?: (message: ServerMessage) => void;
}
/** Browser completion is explicit through complete(), so fixtures do not depend on wall time. */
export class FakeProviderLogin {
  scenarios: Partial<Record<ProviderKind, Scenario>> = {};
  private jobs = new Map<string, Job>();
  private subscribers = new Map<(message: ServerMessage) => void, string>();
  private dismissed = new Set<string>();
  private sequence = 0;
  private now: () => number;
  private statuses: () => ProviderStatus[];
  private openTerminal: (
    progress: ProviderLoginProgress,
    push: (message: ServerMessage) => void,
  ) => string;
  private changed: (
    provider: ProviderKind,
    signedIn: boolean,
    instance?: string,
    method?: "login" | "api_key",
  ) => void;
  constructor(
    now: () => number,
    statuses: () => ProviderStatus[],
    changed: (
      provider: ProviderKind,
      signedIn: boolean,
      instance?: string,
      method?: "login" | "api_key",
    ) => void,
    openTerminal: (
      progress: ProviderLoginProgress,
      push: (message: ServerMessage) => void,
    ) => string,
  ) {
    this.now = now;
    this.statuses = statuses;
    this.changed = changed;
    this.openTerminal = openTerminal;
  }
  /** Stage a device's setup as done (or not), as `onboarding.dismiss` from it would. */
  dismiss(device: string, dismissed = true): void {
    if (dismissed) this.dismissed.add(device);
    else this.dismissed.delete(device);
  }
  release(push: (message: ServerMessage) => void): void {
    this.subscribers.delete(push);
    for (const job of this.jobs.values())
      if (job.terminalOwner === push) {
        delete job.terminalOwner;
        if (job.progress.manual) delete job.progress.manual.terminalId;
      }
  }
  complete(session: string, success = true): void {
    const job = this.jobs.get(session);
    if (!job || ["succeeded", "failed", "cancelled"].includes(job.progress.state)) return;
    this.update(job, { state: "verifying" });
    if (success)
      this.changed(
        job.progress.provider,
        job.progress.action === "login",
        job.progress.instance,
        job.progress.method,
      );
    this.update(job, {
      state: success ? "succeeded" : "failed",
      message: success
        ? "CLI authentication updated."
        : "The provider declined sign-in. Try again.",
    });
  }
  private update(job: Job, update: Partial<ProviderLoginProgress>): void {
    const { session, provider, instance, action, method, expiresAt, sequence } = job.progress;
    job.progress = ProviderLoginProgress.parse({
      session,
      provider,
      instance,
      action,
      method,
      expiresAt,
      sequence: sequence + 1,
      ...update,
    });
    for (const [push, owner] of this.subscribers)
      if (owner === job.owner) push({ type: "provider.login.progress", progress: job.progress });
  }
  private challenge(job: Job): void {
    if (job.scenario === "failure") {
      this.complete(job.progress.session, false);
      return;
    }
    if (
      job.scenario === "device_code" ||
      ["codex", "opencode", "pi"].includes(job.progress.provider)
    )
      this.update(job, {
        state: "awaiting_code_entry",
        url:
          job.progress.provider === "codex"
            ? "https://auth.openai.com/codex/device"
            : "https://github.com/login/device",
        userCode: "ACEF-2048",
        hint: "Open this URL on your device and enter the code. The CLI completes sign-in.",
      });
    else
      this.update(job, {
        state: "awaiting_browser",
        url:
          job.progress.provider === "claude"
            ? "https://claude.ai/oauth/authorize?client_id=ace-fake"
            : "https://cursor.com/loginDeepControl",
        hint: "Open this URL on your device to finish the provider's login.",
      });
  }
  handle(
    message: ClientMessage,
    owner: string,
    push: (message: ServerMessage) => void,
    respond = push,
  ): boolean {
    const onboarding = OnboardingRequest.safeParse(message);
    if (onboarding.success) {
      if (onboarding.data.type === "onboarding.dismiss") {
        if (onboarding.data.dismissed) this.dismissed.add(owner);
        else this.dismissed.delete(owner);
      }
      push({
        type: "onboarding.result",
        requestId: onboarding.data.requestId,
        result: {
          ok: true,
          dismissed: this.dismissed.has(owner),
          ...onboardingChecklist(this.statuses()),
        },
      });
      return true;
    }
    const parsed = ProviderLoginRequest.safeParse(message);
    if (!parsed.success) return false;
    this.subscribers.set(push, owner);
    const input = parsed.data;
    const error = (
      category: "busy" | "not_found" | "forbidden" | "invalid_input" | "unavailable",
    ) =>
      respond({
        type: "provider.login.result",
        requestId: input.requestId,
        result: { ok: false, error: category },
      });
    const reply = (job: Job) =>
      respond({
        type: "provider.login.result",
        requestId: input.requestId,
        result: { ok: true, progress: job.progress },
      });
    for (const [id, job] of this.jobs)
      if (job.progress.expiresAt <= this.now()) {
        if (!["succeeded", "failed", "cancelled"].includes(job.progress.state))
          this.update(job, { state: "failed", message: "Sign-in timed out. Try again." });
        this.jobs.delete(id);
      }
    if (input.type === "provider.login.start" || input.type === "provider.logout") {
      if (
        input.type === "provider.login.start" &&
        input.method === "api_key" &&
        (!fakeApiKeySupport(input.provider).supported ||
          (input.provider === "opencode" && !input.upstream))
      ) {
        error("unavailable");
        return true;
      }

      const instance =
        input.instance === `${input.provider}-cli-default` ? undefined : input.instance;
      const retried = [...this.jobs.values()].find(
        (job) =>
          job.owner === owner &&
          job.requestId === input.requestId &&
          job.progress.provider === input.provider &&
          job.progress.instance === instance,
      );
      if (retried) {
        reply(retried);
        return true;
      }
      const active = [...this.jobs.values()].some(
        (job) =>
          job.progress.provider === input.provider &&
          job.progress.instance === instance &&
          !["succeeded", "failed", "cancelled"].includes(job.progress.state),
      );
      if (active || this.jobs.size >= 32) {
        error("busy");
        return true;
      }
      const scenario =
        this.scenarios[input.provider] ??
        (input.provider === "opencode" || input.provider === "pi"
          ? "choice"
          : input.provider === "codex"
            ? "device_code"
            : "browser");
      const job: Job = {
        owner,
        requestId: input.requestId,
        scenario,
        progress: {
          session: `fake-login-${++this.sequence}`,
          provider: input.provider,
          ...(instance ? { instance } : {}),
          action: input.type === "provider.logout" ? "logout" : "login",
          ...(input.type === "provider.login.start" ? { method: input.method ?? "login" } : {}),
          state: "starting",
          expiresAt: this.now() + 600_000,
          sequence: 0,
        },
      };
      this.jobs.set(job.progress.session, job);
      reply(job);
      if (input.type === "provider.logout") this.complete(job.progress.session);
      else if (input.method === "api_key")
        this.update(job, {
          state: "awaiting_api_key",
          prompt: "Enter the API key for this account.",
        });
      else if (scenario === "choice")
        this.update(job, {
          state: "awaiting_input",
          prompt: "Choose the account provider.",
          choices: [
            { id: "github-copilot", label: "GitHub Copilot" },
            { id: "openai", label: "OpenAI / ChatGPT" },
            { id: "anthropic", label: "Claude" },
            ...(input.provider === "opencode"
              ? [
                  { id: "opencode-go", label: "OpenCode Go" },
                  { id: "opencode", label: "OpenCode Zen" },
                ]
              : []),
          ],
        });
      else this.challenge(job);
      return true;
    }
    const job = this.jobs.get(input.session);
    if (!job) {
      error("not_found");
      return true;
    }
    if (job.owner !== owner) {
      error("forbidden");
      return true;
    }
    if (input.type === "provider.login.apiKey") {
      input.apiKey = "";
      if (message.type === "provider.login.apiKey") message.apiKey = "";
      if (job.progress.state !== "awaiting_api_key") {
        error("invalid_input");
        return true;
      }
      this.complete(job.progress.session, job.scenario !== "failure");
    }
    if (input.type === "provider.login.cancel") {
      if (!["succeeded", "failed", "cancelled"].includes(job.progress.state))
        this.update(job, { state: "cancelled", message: "Sign-in cancelled." });
    }
    if (input.type === "provider.login.terminal") {
      if (!job.progress.manual) {
        error("unavailable");
        return true;
      }
      job.progress = ProviderLoginProgress.parse({
        ...job.progress,
        manual: {
          ...job.progress.manual,
          terminalId: job.progress.manual.terminalId ?? this.openTerminal(job.progress, push),
        },
      });
      job.terminalOwner = push;
      reply(job);
      return true;
    }
    if (input.type === "provider.login.input") {
      if (job.progress.state !== "awaiting_input") {
        error("invalid_input");
        return true;
      }
      if ("choice" in input.input) {
        const choiceId = input.input.choice;
        if (!job.progress.choices?.some((choice) => choice.id === choiceId)) {
          error("invalid_input");
          return true;
        }
        if (["opencode-go", "opencode", "anthropic"].includes(input.input.choice)) {
          this.update(job, {
            state: "failed",
            manual: {
              action: "open_terminal",
              command: job.progress.provider === "pi" ? "pi" : "opencode auth login",
              instruction:
                "Complete this provider's credential entry directly in the CLI terminal.",
            },
          });
        } else this.update(job, { state: "awaiting_input", prompt: "Press Enter to continue." });
      } else this.challenge(job);
    }
    reply(job);
    return true;
  }
}
export function fakeReadiness(rows: ProviderStatus[]): ProviderStatus[] {
  return rows.map(providerReadiness);
}
