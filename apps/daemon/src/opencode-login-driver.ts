import {
  loginObservation,
  loginUrl,
  openCodeAuthArgs,
  openCodeAuthSteps,
  openCodeLoginChoices,
  ProviderLoginFailure,
  type LoginUpdate,
  type ProviderLoginDriver,
} from "@ace/accounts";
import type { OpenCodeSignIn } from "@ace/adapter-opencode/sign-in";
import {
  openCodeFormStep,
  openCodeSignInChoices,
  type SignInChoice,
} from "@ace/adapter-opencode/sign-in-choices";
import type { PiLoginOptions } from "./pi-login-driver.ts";

/** OpenCode attempts expire on their own; this only paces the status reads. */
const pollMs = 1000;

/**
 * OpenCode v2 sign-in. OpenCode's own server lists its integrations: a browser method (the
 * OpenCode account for Go and Zen, GitHub Copilot, ChatGPT) runs in ace's dialog, with the page
 * and code OpenCode returns. Keys, typed form fields and sign-out stay in OpenCode's terminal,
 * which also takes over whenever the server can't be reached.
 */
export function openCodeLoginDriver(
  options: PiLoginOptions & {
    onIntegration?(id: string): void;
    /** OpenCode's server for this sign-in; absent or failing, the terminal flow runs. */
    signIn?(signal: AbortSignal): Promise<OpenCodeSignIn>;
    pollMs?: number;
  },
): ProviderLoginDriver {
  let choose: ((choice: string) => void) | undefined;
  let terminal: ReturnType<NonNullable<PiLoginOptions["openTerminal"]>> | undefined;
  let server: OpenCodeSignIn | undefined;
  const ask = (
    signal: AbortSignal,
    emit: (update: LoginUpdate) => void,
    update: LoginUpdate & { choices: { id: string; label: string }[] },
  ) =>
    new Promise<string>((resolve, reject) => {
      const abort = () => {
        choose = undefined;
        reject(new Error("Cancelled"));
      };
      signal.addEventListener("abort", abort, { once: true });
      choose = (choice) => {
        if (!update.choices.some((offered) => offered.id === choice)) return;
        signal.removeEventListener("abort", abort);
        choose = undefined;
        resolve(choice);
      };
      emit(update);
      if (signal.aborted) abort();
    });
  const inTerminal = async (
    signal: AbortSignal,
    emit: (update: LoginUpdate) => void,
    route: { integration?: string; method?: string; label?: string },
  ) => {
    if (!options.openTerminal)
      throw new ProviderLoginFailure(
        "The sign-in terminal is unavailable. Reconnect to the computer running ace and try again.",
      );
    options.assertCurrent?.();
    if (route.integration) options.onIntegration?.(route.integration);
    terminal = options.openTerminal({
      shell: options.command,
      args: openCodeAuthArgs(options.action, route.integration, route.method),
      cwd: options.cwd,
      env: options.env,
      cols: 100,
      rows: 30,
      name: "OpenCode v2 sign-in",
    });
    const abort = () => {
      void terminal?.stop();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      emit({
        state: "awaiting_input",
        manual: {
          action: "open_terminal",
          ...openCodeAuthSteps(options.action, route.integration, route.method, route.label),
          terminalId: terminal.id,
        },
      });
      if (signal.aborted) abort();
      const success = await terminal.exited;
      signal.throwIfAborted();
      options.assertCurrent?.();
      return { success };
    } finally {
      signal.removeEventListener("abort", abort);
    }
  };
  const inBrowser = async (
    signal: AbortSignal,
    emit: (update: LoginUpdate) => void,
    open: OpenCodeSignIn,
    choice: SignInChoice & { route: { kind: "browser" } },
  ) => {
    const { integration, method, fields } = choice.route;
    const answer: Record<string, string> = {};
    let filled: Record<string, string> | undefined;
    while (!filled) {
      const step = openCodeFormStep(fields, answer);
      if (step.kind === "done") {
        filled = step.answer;
        break;
      }
      if (step.kind === "text")
        return inTerminal(signal, emit, { integration, method, label: choice.label });
      const picked = await ask(signal, emit, {
        state: "awaiting_input",
        prompt: (step.field.title ?? "Choose one.").slice(0, 256),
        choices: step.field.options
          .slice(0, 32)
          .map((option, index) => ({ id: `option-${index}`, label: option.label.slice(0, 128) })),
      });
      const option = step.field.options[Number(/^option-(\d+)$/.exec(picked)?.[1])];
      if (!option) throw new Error("Unknown sign-in option");
      answer[step.field.key] = option.value;
    }
    options.assertCurrent?.();
    options.onIntegration?.(integration);
    const attempt = await open.begin(integration, method, filled);
    // Only reviewed pages cross the wire; anything else, or a code to paste back, is OpenCode's
    // terminal's to handle.
    const url = attempt.url ? loginUrl("opencode", attempt.url) : undefined;
    if (attempt.mode !== "auto" || (attempt.url && !url)) {
      await open.cancel(integration, attempt.attemptID).catch(() => {});
      return inTerminal(signal, emit, { integration, method, label: choice.label });
    }
    const userCode = loginObservation("opencode", attempt.instructions)?.userCode;
    emit({
      state: userCode ? "awaiting_code_entry" : "awaiting_browser",
      ...(url ? { url } : {}),
      ...(userCode ? { userCode } : {}),
    });
    let settled = false;
    try {
      for (;;) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, options.pollMs ?? pollMs);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("Cancelled"));
            },
            { once: true },
          );
        });
        const status = await open.status(integration, attempt.attemptID);
        if (status === "pending") continue;
        settled = true;
        if (status === "complete") {
          options.assertCurrent?.();
          return { success: true };
        }
        throw new ProviderLoginFailure(
          status === "expired"
            ? "The sign-in code expired. Start again."
            : "OpenCode couldn't finish signing in. Start again.",
        );
      }
    } finally {
      if (!settled) await open.cancel(integration, attempt.attemptID).catch(() => {});
    }
  };
  return {
    input(input) {
      if (!("choice" in input) || !choose) return false;
      choose(input.choice);
      return true;
    },
    async drain() {
      await terminal?.stop();
      await server?.close();
    },
    async run(signal, emit) {
      if (!/^2\.\d+\.\d+(?:-[\w.-]+)?$/.test(options.version ?? ""))
        throw new ProviderLoginFailure(
          "Install OpenCode v2 from Settings → Providers, then try signing in again.",
        );
      let choices: SignInChoice[] | undefined;
      if (options.action === "login" && options.signIn)
        try {
          server = await options.signIn(signal);
          choices = openCodeSignInChoices(await server.integrations());
        } catch {
          // OpenCode's own terminal still signs in when its server can't answer.
          signal.throwIfAborted();
          await server?.close();
          server = undefined;
        }
      try {
        const offered =
          choices ??
          openCodeLoginChoices.map(({ id, label }): SignInChoice => ({
            id,
            label,
            route: { kind: "terminal", integration: id },
          }));
        const picked = await ask(signal, emit, {
          state: "awaiting_input",
          choices: offered.map(({ id, label }) => ({ id, label })),
        });
        signal.throwIfAborted();
        const choice = offered.find((candidate) => candidate.id === picked);
        if (!choice) throw new Error("Unknown sign-in choice");
        if (choice.route.kind === "browser" && server)
          return await inBrowser(signal, emit, server, {
            ...choice,
            route: choice.route,
          });
        return await inTerminal(signal, emit, {
          ...(choice.route.integration ? { integration: choice.route.integration } : {}),
          ...(choice.route.kind === "terminal" && choice.route.method
            ? { method: choice.route.method }
            : {}),
          label: choice.label,
        });
      } finally {
        await server?.close();
        server = undefined;
      }
    },
  };
}
