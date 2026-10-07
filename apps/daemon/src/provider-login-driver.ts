import {
  loginArgs,
  logoutArgs,
  loginObservation,
  type ProviderLoginDriver,
  type LoginUpdate,
} from "@ace/accounts";
import type { ProviderKind, ProviderLoginInput, ProviderLoginProgress } from "@ace/protocol";
import type { TerminalManager } from "@ace/terminal";
import { stripVTControlCharacters } from "node:util";

export const upstreamChoices = {
  opencode: [
    { id: "github-copilot", label: "GitHub Copilot" },
    { id: "openai", label: "OpenAI / ChatGPT" },
    { id: "anthropic", label: "Anthropic" },
    { id: "opencode-go", label: "OpenCode Go" },
    { id: "opencode", label: "OpenCode Zen" },
    { id: "other", label: "Other provider (terminal)" },
  ],
  pi: [
    { id: "github-copilot", label: "GitHub Copilot" },
    { id: "openai-codex", label: "ChatGPT / Codex" },
    { id: "anthropic", label: "Claude" },
    { id: "google-gemini-cli", label: "Google Gemini CLI" },
    { id: "google-antigravity", label: "Google Antigravity" },
    { id: "other", label: "Other provider (terminal)" },
  ],
};
type NativeLoginProvider = Exclude<ProviderKind, "cursor">;
export function manualLogin(
  provider: NativeLoginProvider,
  action: "login" | "logout",
  instance?: string,
): NonNullable<ProviderLoginProgress["manual"]> {
  const command =
    provider === "pi"
      ? "pi"
      : provider === "claude"
        ? `claude auth ${action}`
        : provider === "opencode"
          ? `opencode auth ${action}`
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
}
/** PTY output has no scrollback or logging. Only finite, reviewed observations leave here. */
export function cliLoginDriver(options: CliLoginOptions): ProviderLoginDriver {
  const { provider, action, help } = options;
  const manual = manualLogin(provider, action, options.instance);
  let live: ReturnType<TerminalManager["openLiveTerminal"]> | undefined;
  let enter: (() => void) | undefined;
  let nativeChoice: ((choice: string) => boolean) | undefined;
  let select: ((choice: string) => void) | undefined;
  return {
    manual,
    async drain() {
      if (live) {
        await options.manager.releaseLive(live);
        live = undefined;
      }
    },
    input(input: ProviderLoginInput) {
      if ("choice" in input && nativeChoice) return nativeChoice(input.choice);
      if ("choice" in input && select) {
        const choices =
          provider === "opencode"
            ? upstreamChoices.opencode
            : provider === "pi"
              ? upstreamChoices.pi
              : [];
        if (!choices.some((choice) => choice.id === input.choice)) return false;
        const accept = select;
        select = undefined;
        accept(input.choice);
        return true;
      }
      if (("confirm" in input || "value" in input) && enter) {
        const accept = enter;
        enter = undefined;
        accept();
        return true;
      }
      return false;
    },
    async run(signal, emit) {
      let upstream: string | undefined;
      if (provider === "opencode" || provider === "pi") {
        upstream = await new Promise<string>((resolve, reject) => {
          const abort = () => {
            select = undefined;
            reject(new Error("Cancelled"));
          };
          signal.addEventListener("abort", abort, { once: true });
          select = (choice) => {
            signal.removeEventListener("abort", abort);
            resolve(choice);
          };
          emit({
            state: "awaiting_input",
            prompt: "Choose the account provider.",
            choices: upstreamChoices[provider],
          });
          if (signal.aborted) abort();
        });
      }
      signal.throwIfAborted();
      // Pi exposes /login inside its editor, with no reviewed unattended command.
      // Key entry and paste-code providers always stay in the native terminal.
      if (
        provider === "pi" ||
        (provider === "opencode" && (upstream !== "github-copilot" || action === "logout"))
      )
        return {
          success: false,
          manual: {
            ...manual,
            instruction: `${manual.instruction} Choose ${upstreamChoices[provider].find((choice) => choice.id === upstream)?.label ?? "your provider"} in the CLI's provider menu.`,
          },
        };
      if (provider === "acp" || provider === "antigravity") return { success: false, manual };
      const supportedVersion =
        provider === "codex"
          ? /^(?:0|1)\.\d+\.\d+$/
          : provider === "claude"
            ? /^2\.\d+\.\d+$/
            : /^(?:1|2)\.\d+\.\d+$/;
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
      if (provider === "opencode")
        args.push("--provider", "github-copilot", "--method", "Login with GitHub Copilot");
      if (provider === "opencode" && (!help.includes("--provider") || !help.includes("--method")))
        return { success: false, manual };
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
        codePending = /(?:one.time|device|user|enter).*code[:\s]*$/i.test(clean);
        if (
          provider === "opencode" &&
          /(?:select.*github (?:domain|instance|deployment)|select.*deployment|github\.com.*github enterprise|^.*GitHub\.com\s*$)/i.test(
            clean,
          )
        ) {
          nativeChoice = (choice) => {
            if (choice === "github-com") {
              terminal?.write("\r");
              nativeChoice = undefined;
              emit({ state: "verifying" });
              return true;
            }
            if (choice === "github-enterprise") {
              blocked = true;
              void terminal?.close(500).catch(() => {});
              nativeChoice = undefined;
              return true;
            }
            return false;
          };
          emit({
            state: "awaiting_input",
            prompt: "Choose your GitHub account host.",
            choices: [
              { id: "github-com", label: "GitHub.com" },
              { id: "github-enterprise", label: "GitHub Enterprise (terminal)" },
            ],
          });
          return;
        }
        const observation = loginObservation(provider, clean);
        if (!observation) return;
        if (observation.manualRequired) {
          blocked = true;
          return;
        }
        if (observation.enter)
          enter = () => {
            if (!signal.aborted) {
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
        nativeChoice = undefined;
        signal.removeEventListener("abort", cancel);
        await options.manager.releaseLive(terminal);
      }
    },
  };
}
