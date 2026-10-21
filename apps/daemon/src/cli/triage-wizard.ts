import { cancel, intro, log, multiselect, note, outro, select, spinner } from "@clack/prompts";
import { styleText } from "node:util";

export class TriageCancelled extends Error {}
const io = { input: process.stdin, output: process.stderr };
type Style = Parameters<typeof styleText>[0];
/** Colour only when stderr is a colour terminal; NO_COLOR and pipes stay plain. */
export const paint = (style: Style, value: string) =>
  styleText(style, value, { stream: process.stderr });

function accepted<T extends string | string[]>(value: T | symbol): T {
  if (typeof value === "symbol") {
    cancel("Nothing was changed or started.", io);
    throw new TriageCancelled();
  }
  return value;
}
export type Choice<T extends string> = {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean;
};

export function triageWizard(title: string) {
  intro(title, io);
  return {
    async choose<T extends string>(
      message: string,
      choices: readonly Choice<T>[],
      initialValue?: T,
    ): Promise<T> {
      const value = accepted(
        await select({
          ...io,
          message,
          options: choices.map((choice) => ({ ...choice, value: String(choice.value) })),
          ...(initialValue ? { initialValue } : {}),
        }),
      );
      const choice = choices.find((entry) => entry.value === value);
      if (!choice) throw new Error("Unknown triage choice");
      return choice.value;
    },
    /** A checklist; returns the chosen values in list order. */
    async pickMany<T extends string>(
      message: string,
      choices: readonly Choice<T>[],
      chosen: readonly T[],
    ): Promise<T[]> {
      const values = accepted<string[]>(
        await multiselect({
          ...io,
          message,
          required: false,
          options: choices.map((choice) => ({ ...choice, value: String(choice.value) })),
          initialValues: chosen.map(String),
        }),
      );
      return choices.filter((choice) => values.includes(choice.value)).map((c) => c.value);
    },
    summary(text: string, heading: string) {
      note(text, heading, io);
    },
    warn(message: string) {
      log.warn(message, io);
    },
    async progress<T>(message: string, done: string, run: () => Promise<T>): Promise<T> {
      const status = spinner(io);
      status.start(message);
      try {
        const result = await run();
        status.stop(done);
        return result;
      } catch (error) {
        status.error("Couldn't finish");
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
export type TriageWizard = ReturnType<typeof triageWizard>;
