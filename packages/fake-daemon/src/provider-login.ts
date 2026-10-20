import { openCodeAuthSteps, openCodeLoginChoices } from "@ace/accounts/opencode-auth";
import { fakeApiKeySupport } from "./provider-auth-support.ts";
import { ProviderLoginRequest, ProviderLoginProgress, OnboardingRequest } from "@ace/protocol";
import { onboardingChecklist, providerReadiness } from "@ace/core";
import type {
  ClientMessage,
  ProviderKind,
  ProviderLoginUnavailableReason,
  ProviderStatus,
  ServerMessage,
} from "@ace/protocol";

/** `paste_code`: Claude Code's own flow, a browser opened here plus a fallback page's code. */
type Scenario = "device_code" | "browser" | "choice" | "failure" | "paste_code";
/** Claude's fallback page: it shows `code#state`, pasted back into the CLI. */
const claudeFallback =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=ace-fake&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback";
interface Job {
  owner: string;
  requestId: string;
  progress: ProviderLoginProgress;
  scenario: Scenario;
  choice?: string;
  settled?: ((state: "succeeded" | "failed" | "cancelled") => void) | undefined;
  terminalOwner?: (message: ServerMessage) => void;
}
/** Browser completion is explicit through complete(), so fixtures do not depend on wall time. */
export class FakeProviderLogin {
  scenarios: Partial<Record<ProviderKind, Scenario>> = {};
  /** Providers whose sign-in the daemon can't run, and the reason it gives. */
  refusals: Partial<Record<ProviderKind, ProviderLoginUnavailableReason>> = {};
  /** What a successful sign-in or sign-out still tells the person, per provider. */
  successNotes: Partial<Record<ProviderKind, string>> = {};
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
  finishTerminal(session: string): void {
    const job = this.jobs.get(session);
    if (!job?.progress.manual) return;
    if (
      ["pi", "opencode"].includes(job.progress.provider) &&
      job.progress.state === "awaiting_input"
    ) {
      this.complete(session);
      return;
    }
    if (job.progress.state !== "failed") return;
    job.settled?.("succeeded");
    job.settled = undefined;
    this.changed(
      job.progress.provider,
      job.progress.action === "login",
      job.progress.instance,
      job.progress.method,
    );
  }
  complete(session: string, success = true): void {
    const job = this.jobs.get(session);
    if (
      !job ||
      job.progress.state === "succeeded" ||
      job.progress.state === "cancelled" ||
      (job.progress.state === "failed" && !job.progress.manual)
    )
      return;
    this.update(job, { state: "verifying" });
    job.settled?.(success ? "succeeded" : "failed");
    job.settled = undefined;
    if (success)
      this.changed(
        job.progress.provider,
        job.progress.action === "login",
        job.progress.instance,
        job.progress.method,
      );
    // Like the daemon, a success carries a message only when the person still needs to know it.
    const message = success
      ? this.successNotes[job.progress.provider]
      : "The provider declined sign-in. Try again.";
    this.update(job, {
      state: success ? "succeeded" : "failed",
      ...(message ? { message } : {}),
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
    if (job.scenario === "paste_code") {
      this.update(job, { state: "awaiting_browser", url: claudeFallback, codeEntry: true });
      return;
    }
    if (
      job.scenario === "device_code" ||
      job.progress.provider === "codex" ||
      (job.progress.provider === "pi" && job.choice !== "anthropic")
    )
      this.update(job, {
        state: "awaiting_code_entry",
        url:
          job.progress.provider === "codex" ||
          (job.progress.provider === "pi" && job.choice === "openai-codex")
            ? "https://auth.openai.com/codex/device"
            : "https://github.com/login/device",
        userCode: "ACEF-2048",
        hint: "Open this URL on your device and enter the code. The CLI completes sign-in.",
      });
    else
      this.update(job, {
        state: "awaiting_browser",
        url:
          job.progress.provider === "claude" ||
          (job.progress.provider === "pi" && job.choice === "anthropic")
            ? "https://claude.ai/oauth/authorize?client_id=ace-fake"
            : job.progress.provider === "acp" || job.progress.provider === "antigravity"
              ? "https://accounts.google.com/o/oauth2/v2/auth?client_id=ace-fake"
              : "https://cursor.com/loginDeepControl",
        hint: "Open this URL on your device to finish the provider's login.",
      });
  }
  handle(
    message: ClientMessage,
    owner: string,
    push: (message: ServerMessage) => void,
    respond = push,
    settled?: Job["settled"],
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
        if (job.settled || !["succeeded", "failed", "cancelled"].includes(job.progress.state)) {
          job.settled?.("failed");
          job.settled = undefined;
          this.update(job, { state: "failed", message: "Sign-in timed out. Try again." });
        }
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
      const refusal = this.refusals[input.provider];
      if (refusal) {
        respond({
          type: "provider.login.result",
          requestId: input.requestId,
          result: { ok: false, error: "unavailable", reason: refusal },
        });
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
        settled,
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
          choices:
            input.provider === "opencode"
              ? openCodeLoginChoices
              : [
                  { id: "github-copilot", label: "GitHub Copilot" },
                  { id: "openai-codex", label: "ChatGPT / Codex" },
                  { id: "anthropic", label: "Claude" },
                  { id: "other", label: "Other provider" },
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
      if (job.settled || !["succeeded", "failed", "cancelled"].includes(job.progress.state)) {
        job.settled?.("cancelled");
        job.settled = undefined;
        this.update(job, { state: "cancelled", message: "Sign-in cancelled." });
      }
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
    if (input.type === "provider.login.input" && "code" in input.input) {
      // Only a CLI waiting for one takes a code; it answers that prompt and is never kept.
      const waiting = job.progress.codeEntry === true;
      input.input.code = "";
      if (!waiting) error("invalid_input");
      else this.complete(job.progress.session);
      if (waiting) reply(job);
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
        job.choice = choiceId;
        if (job.progress.provider === "pi") {
          if (choiceId === "other") {
            this.update(job, {
              state: "awaiting_input",
              manual: {
                action: "open_terminal",
                command: "pi",
                instruction:
                  "Type /login, choose your provider, then finish its prompts. Exit Pi when you're done.",
              },
            });
            const terminalId = this.openTerminal(job.progress, push);
            job.terminalOwner = push;
            this.update(job, {
              state: "awaiting_input",
              manual: {
                action: "open_terminal",
                command: "pi",
                instruction:
                  "Type /login, choose your provider, then finish its prompts. Exit Pi when you're done.",
                terminalId,
              },
            });
          } else this.challenge(job);
        } else if (job.progress.provider === "opencode") {
          const steps = openCodeAuthSteps(job.progress.action, choiceId);
          this.update(job, {
            state: "awaiting_input",
            manual: { action: "open_terminal", ...steps },
          });
          const terminalId = this.openTerminal(job.progress, push);
          job.terminalOwner = push;
          this.update(job, {
            state: "awaiting_input",
            manual: { action: "open_terminal", ...steps, terminalId },
          });
        }
      } else this.challenge(job);
    }
    reply(job);
    return true;
  }
}
export function fakeReadiness(rows: ProviderStatus[]): ProviderStatus[] {
  return rows.map(providerReadiness);
}
