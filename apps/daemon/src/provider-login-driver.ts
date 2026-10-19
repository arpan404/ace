import { openCodeLoginDriver } from "./opencode-login-driver.ts";
import { piLoginDriver, piLoginChoices, type PiLoginOptions } from "./pi-login-driver.ts";
import {
  loginArgs,
  openCodeAuthSteps,
  openCodeLoginChoices,
  logoutArgs,
  loginObservation,
  loginDeviceCodePrompt,
  type ProviderLoginDriver,
  type LoginUpdate,
} from "@ace/accounts";
import type { ProviderKind, ProviderLoginInput, ProviderLoginProgress } from "@ace/protocol";
import type { TerminalManager } from "@ace/terminal";
import { stripVTControlCharacters } from "node:util";

export const upstreamChoices = {
  opencode: openCodeLoginChoices,
  pi: piLoginChoices,
};
type NativeLoginProvider = Exclude<ProviderKind, "cursor">;
export function manualLogin(
  provider: NativeLoginProvider,
  action: "login" | "logout",
  instance?: string,
): NonNullable<ProviderLoginProgress["manual"]> {
  if (provider === "opencode")
    return {
      action: "open_terminal",
      ...openCodeAuthSteps(action),
      ...(instance ? { instance } : {}),
    };
  const command =
    provider === "pi"
      ? "pi"
      : provider === "claude"
        ? `claude auth ${action}`
        : provider === "codex"
          ? `codex ${action}`
          : provider === "antigravity"
            ? "agy"
            : "Use the agent's own CLI";
  return {
    action: "open_terminal",
    command,
    instruction:
      provider === "pi"
        ? `Run pi, then /${action}. Choose your provider and complete its own prompts in the terminal.`
        : `Run ${command} and complete the CLI's prompts in the terminal. Enter credentials only into the CLI.`,
    ...(instance ? { instance } : {}),
  };
}
export interface CliLoginOptions {
  provider: NativeLoginProvider;
  action: "login" | "logout";
  instance?: string;
  command: string;
  version?: string;
  help: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  manager: TerminalManager;
  openTerminal?: PiLoginOptions["openTerminal"];
  assertCurrent?(): void;
  onIntegration?(id: string): void;
  /** OpenCode's own server for a browser sign-in in ace's dialog. */
  openCodeSignIn?(
    signal: AbortSignal,
  ): Promise<import("@ace/adapter-opencode/sign-in").OpenCodeSignIn>;
}
/** PTY output has no scrollback or logging. Only finite, reviewed observations leave here. */
export function cliLoginDriver(options: CliLoginOptions): ProviderLoginDriver {
  const { provider, action, help } = options;
  if (provider === "pi") return piLoginDriver(options);
  if (provider === "opencode")
    return openCodeLoginDriver({
      ...options,
      ...(options.openCodeSignIn ? { signIn: options.openCodeSignIn } : {}),
    });
  const manual = manualLogin(provider, action, options.instance);
  let live: ReturnType<TerminalManager["openLiveTerminal"]> | undefined;
  let enter: (() => void) | undefined;
  return {
    manual,
    async drain() {
      if (live) {
        await options.manager.releaseLive(live);
        live = undefined;
      }
    },
    input(input: ProviderLoginInput) {
      if (("confirm" in input || "value" in input) && enter) {
        const accept = enter;
        enter = undefined;
        accept();
        return true;
      }
      return false;
    },
    async run(signal, emit) {
      signal.throwIfAborted();
      if (provider === "acp" || provider === "antigravity") return { success: false, manual };
      const supportedVersion = provider === "codex" ? /^(?:0|1)\.\d+\.\d+$/ : /^2\.\d+\.\d+$/;
      if (
        !options.version ||
        !supportedVersion.test(options.version) ||
        !new RegExp(`\\b${action}\\b`).test(help)
      )
        return { success: false, manual };
      const args = action === "login" ? loginArgs(provider) : logoutArgs(provider);
      if (action === "login" && provider === "codex" && help.includes("--device-auth"))
        args.push("--device-auth");
      if (provider === "claude" && !help.includes("--claudeai")) {
        const at = args.indexOf("--claudeai");
        if (at >= 0) args.splice(at, 1);
      }
      if (action === "login" && help.includes("--no-browser")) args.push("--no-browser");
      let pending = "";
      let bytes = 0;
      let blocked = false;
      let output: LoginUpdate = { state: "starting" };
      let terminal: ReturnType<TerminalManager["openLiveTerminal"]> | undefined;
      let codePending = false;
      const observe = (line: string) => {
        let clean = stripVTControlCharacters(line);
        if (codePending && /^\s*[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\s*$/.test(clean))
          clean = `Enter code: ${clean.trim()}`;
        codePending = loginDeviceCodePrompt(clean);
        const observation = loginObservation(provider, clean);
        if (!observation) return;
        if (observation.manualRequired) {
          blocked = true;
          return;
        }
        if (observation.enter)
          enter = () => {
            if (!signal.aborted) {
              options.assertCurrent?.();
              terminal?.write("\r");
              emit({ state: "verifying" });
            }
          };
        output = {
          state: observation.state,
          ...(observation.url ? { url: observation.url } : output.url ? { url: output.url } : {}),
          ...(observation.userCode
            ? { userCode: observation.userCode }
            : output.userCode
              ? { userCode: output.userCode }
              : {}),
          ...(observation.prompt ? { prompt: observation.prompt } : {}),
        };
        emit(output);
      };
      options.assertCurrent?.();
      terminal = options.manager.openLiveTerminal(
        {
          shell: options.command,
          args,
          env: { ...options.env, BROWSER: "echo" },
          cwd: options.cwd,
          cols: 100,
          rows: 30,
          name: `${provider} ${action}`,
        },
        (event) => {
          if (event.type !== "data" || blocked || signal.aborted) return;
          bytes += Buffer.byteLength(event.data);
          if (bytes > 256 * 1024) {
            blocked = true;
            void terminal?.close(500).catch(() => {});
            return;
          }
          pending += event.data;
          const lines = pending.split(/\r\n|\n|\r/);
          pending = lines.pop() ?? "";
          for (const line of lines) observe(line);
          if (pending.length > 8192) {
            pending = "";
            blocked = true;
          }
          // Recognize no-newline prompts without treating a partial URL as complete.
          if (
            /press (?:enter|return)|hit enter|(?:enter|paste|provide).*(?:key|token|authorization code)/i.test(
              pending,
            )
          ) {
            observe(pending);
            pending = "";
          }
          if (blocked) void terminal?.close(500).catch(() => {});
        },
      );
      live = terminal;
      const cancel = () => {
        void terminal?.close(500).catch(() => {});
      };
      signal.addEventListener("abort", cancel, { once: true });
      if (blocked || signal.aborted) cancel();
      try {
        const exit = await terminal.exited;
        await options.manager.releaseLive(terminal);
        signal.throwIfAborted();
        if (pending && !blocked) observe(pending);
        return {
          success: exit.code === 0 && !blocked,
          ...(blocked || exit.code !== 0 ? { manual } : {}),
        };
      } finally {
        enter = undefined;
        signal.removeEventListener("abort", cancel);
        await options.manager.releaseLive(terminal);
      }
    },
  };
}
