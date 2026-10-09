import { serviceLabel } from "@ace/models/service-labels";
import type { ProviderLoginDriver } from "@ace/accounts";
import { loginUrl } from "@ace/accounts";
import { spawnSupervised, type SupervisedProcess } from "@ace/provider-kit/process";
import type { OpenTerminalOptions } from "@ace/terminal";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { piLoginRuntime } from "./pi-login-runtime.ts";

export const piLoginChoices = ["github-copilot", "openai-codex", "anthropic", "other"].map(
  (id) => ({ id, label: serviceLabel(id) }),
);
const Frame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth_url"), url: z.string().max(8192) }),
  z.object({
    type: z.literal("device_code"),
    verificationUri: z.string().max(8192),
    userCode: z.string().regex(/^[A-Z0-9]{4,5}-[A-Z0-9]{4,5}$/),
  }),
  z.object({ type: z.literal("complete") }),
]);
export interface PiLoginOptions {
  command: string;
  version?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  action: "login" | "logout";
  openTerminal?:
    | ((launch: OpenTerminalOptions) => {
        id: string;
        exited: Promise<boolean>;
        stop(): Promise<void>;
      })
    | undefined;
}

/** Only safe SDK challenges cross the wire. Other services use a subscriber-started native PTY. */
export function piLoginDriver(options: PiLoginOptions): ProviderLoginDriver {
  let choose: ((choice: string) => void) | undefined;
  let child: SupervisedProcess | undefined;
  let terminal: ReturnType<NonNullable<PiLoginOptions["openTerminal"]>> | undefined;
  return {
    input(input) {
      if (
        !("choice" in input) ||
        !choose ||
        !piLoginChoices.some((choice) => choice.id === input.choice)
      )
        return false;
      const accept = choose;
      choose = undefined;
      accept(input.choice);
      return true;
    },
    async drain() {
      await child?.stop();
      await terminal?.stop();
    },
    async run(signal, emit) {
      const upstream = await new Promise<string>((resolve, reject) => {
        const abort = () => {
          choose = undefined;
          reject(new Error("Cancelled"));
        };
        signal.addEventListener("abort", abort, { once: true });
        choose = (choice) => {
          signal.removeEventListener("abort", abort);
          resolve(choice);
        };
        emit({ state: "awaiting_input", choices: piLoginChoices });
        if (signal.aborted) abort();
      });
      signal.throwIfAborted();
      if (upstream === "other") {
        if (!options.openTerminal) throw new Error("Terminal unavailable");
        terminal = options.openTerminal({
          shell: options.command,
          args: [],
          cwd: options.cwd,
          env: options.env,
          cols: 80,
          rows: 24,
          name: "Pi sign-in",
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
              command: "pi",
              instruction: `Type /${options.action}, choose your provider, then finish its prompts. Exit Pi when you're done.`,
              terminalId: terminal.id,
            },
          });
          if (signal.aborted) abort();
          return { success: (await terminal.exited) && !signal.aborted };
        } finally {
          signal.removeEventListener("abort", abort);
        }
      }
      const entry = await piLoginRuntime(options.command, options.version);
      signal.throwIfAborted();
      child = spawnSupervised({
        command: process.execPath,
        args: [
          fileURLToPath(new URL("./pi-login-worker.ts", import.meta.url)),
          entry,
          upstream,
          options.action,
        ],
        cwd: options.cwd,
        env: { ...options.env, NODE_OPTIONS: undefined, NODE_PATH: undefined },
        name: "Pi login",
        maxLineBytes: 16384,
        maxOutputBytes: 262144,
      });
      const owned = child;
      let completed = false;
      let invalid = false;
      const abort = () => {
        void owned.stop();
      };
      signal.addEventListener("abort", abort, { once: true });
      owned.stderr.on("line", () => {});
      owned.stdout.on("line", (line) => {
        if (signal.aborted || invalid) return;
        try {
          const frame = Frame.parse(JSON.parse(line));
          if (frame.type === "complete") {
            completed = true;
            return;
          }
          const url = loginUrl("pi", frame.type === "auth_url" ? frame.url : frame.verificationUri);
          if (!url) throw new Error("Unreviewed login URL");
          emit({
            state: frame.type === "device_code" ? "awaiting_code_entry" : "awaiting_browser",
            url,
            ...(frame.type === "device_code" ? { userCode: frame.userCode } : {}),
          });
        } catch {
          invalid = true;
          abort();
        }
      });
      try {
        if (signal.aborted) abort();
        const exit = await owned.exited;
        signal.throwIfAborted();
        return { success: completed && !invalid && exit.code === 0 && exit.reason === "exit" };
      } finally {
        signal.removeEventListener("abort", abort);
        await owned.stop();
      }
    },
  };
}
