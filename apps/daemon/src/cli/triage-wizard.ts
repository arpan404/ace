import { cancel, intro, multiline, note, outro, select, spinner } from "@clack/prompts";
import { stripVTControlCharacters } from "node:util";

export class TriageCancelled extends Error {}
const io = { input: process.stdin, output: process.stderr };
function accepted(value: string | symbol): string {
  if (typeof value === "symbol") {
    cancel("Cancelled.", io);
    throw new TriageCancelled();
  }
  return value;
}

export function triageWizard() {
  intro("ace triage", io);
  return {
    async choose<T extends string>(
      message: string,
      choices: readonly { value: T; label: string; hint?: string }[],
    ): Promise<T> {
      const value = accepted(
        await select({
          ...io,
          message,
          options: choices.map((choice) => ({ ...choice, value: String(choice.value) })),
        }),
      );
      const choice = choices.find((entry) => entry.value === value);
      if (!choice) throw new Error("Unknown triage choice");
      return choice.value;
    },
    async describe(initialValue?: string): Promise<string> {
      return accepted(
        await multiline({
          ...io,
          message: "Describe what you need (Enter twice to continue)",
          placeholder: "What should happen? What happens today?",
          ...(initialValue ? { initialValue } : {}),
          validate: (value) =>
            !value?.trim()
              ? "Enter a description."
              : value.length > 16_000
                ? "Use at most 16,000 characters."
                : undefined,
        }),
      );
    },
    preview(prompt: string) {
      note(stripVTControlCharacters(prompt), "Prompt", io);
    },
    async progress<T>(run: () => Promise<T>): Promise<T> {
      const status = spinner(io);
      status.start("Checking this computer");
      try {
        const result = await run();
        status.stop("Checks collected");
        return result;
      } catch (error) {
        status.error("Checks failed");
        throw error;
      }
    },
    finish(message: string) {
      outro(message, io);
    },
    close() {
      process.stdin.pause();
    },
  };
}
