import {
  openCodeAuthArgs,
  openCodeAuthSteps,
  openCodeLoginChoices,
  ProviderLoginFailure,
  type ProviderLoginDriver,
} from "@ace/accounts";
import type { PiLoginOptions } from "./pi-login-driver.ts";

/** V2 authentication stays in the CLI's own terminal, including browser and key prompts. */
export function openCodeLoginDriver(
  options: PiLoginOptions & { onIntegration?(id: string): void },
): ProviderLoginDriver {
  let choose: ((choice: string) => void) | undefined;
  let terminal: ReturnType<NonNullable<PiLoginOptions["openTerminal"]>> | undefined;
  return {
    input(input) {
      if (
        !("choice" in input) ||
        !choose ||
        !openCodeLoginChoices.some((choice) => choice.id === input.choice)
      )
        return false;
      const accept = choose;
      choose = undefined;
      accept(input.choice);
      return true;
    },
    async drain() {
      await terminal?.stop();
    },
    async run(signal, emit) {
      if (!/^2\.\d+\.\d+(?:-[\w.-]+)?$/.test(options.version ?? ""))
        throw new ProviderLoginFailure(
          "Install OpenCode v2 from Settings → Providers, then try signing in again.",
        );
      if (!options.openTerminal)
        throw new ProviderLoginFailure(
          "The sign-in terminal is unavailable. Reconnect to the computer running ace and try again.",
        );
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
        emit({ state: "awaiting_input", choices: openCodeLoginChoices });
        if (signal.aborted) abort();
      });
      signal.throwIfAborted();
      options.assertCurrent?.();
      options.onIntegration?.(upstream);
      terminal = options.openTerminal({
        shell: options.command,
        args: openCodeAuthArgs(options.action, upstream),
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
            ...openCodeAuthSteps(options.action, upstream),
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
    },
  };
}
