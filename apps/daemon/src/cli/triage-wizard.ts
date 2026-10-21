import { cancel, intro, log, multiline, note, outro, select, spinner, text } from "@clack/prompts";
import { stripVTControlCharacters, styleText } from "node:util";

export class TriageCancelled extends Error {}
const io = { input: process.stdin, output: process.stderr };
type Style = Parameters<typeof styleText>[0];
/** Colour only when stderr is a colour terminal; NO_COLOR and pipes stay plain. */
export const paint = (style: Style, value: string) =>
  styleText(style, value, { stream: process.stderr });

function accepted(value: string | symbol): string {
  if (typeof value === "symbol") {
    cancel("Nothing was sent.", io);
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
    async ask(input: {
      message: string;
      placeholder: string;
      required: boolean;
      initialValue?: string;
    }): Promise<string> {
      return accepted(
        await multiline({
          ...io,
          message: `${input.message} ${paint("dim", "Enter twice to continue")}`,
          placeholder: input.placeholder,
          ...(input.initialValue ? { initialValue: input.initialValue } : {}),
          validate: (value) =>
            input.required && !value?.trim()
              ? "Describe it in a few words."
              : (value?.length ?? 0) > 16_000
                ? "Use at most 16,000 characters."
                : undefined,
        }),
      );
    },
    async askOptional(input: {
      message: string;
      placeholder: string;
      initialValue?: string;
    }): Promise<string> {
      // clack returns undefined, not "", when the field is left empty.
      const answer: unknown = accepted(
        await text({
          ...io,
          message: input.message,
          placeholder: input.placeholder,
          ...(input.initialValue ? { initialValue: input.initialValue } : {}),
          validate: (value) =>
            (value?.length ?? 0) > 4_000 ? "Use at most 4,000 characters." : undefined,
        }),
      );
      return typeof answer === "string" ? answer : "";
    },
    preview(prompt: string, summary: string) {
      note(highlight(prompt), summary, { ...io, format: (line) => line });
    },
    info(message: string) {
      log.info(message, io);
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

/**
 * Markdown-ish emphasis for the preview. User text is stripped of terminal control
 * sequences first so a pasted escape can't repaint the screen.
 */
export function highlight(prompt: string): string {
  return stripVTControlCharacters(prompt)
    .split("\n")
    .map((line, index) => {
      if (index === 0) return paint("bold", line);
      if (line.startsWith("## ")) return paint(["bold", "cyan"], line.slice(3));
      if (/^- (ERROR|FAIL)\b|^- \d+× error\b|^- error\b/.test(line)) return paint("red", line);
      if (/^- (WARN)\b|^- \d+× warn\b|^- warn\b/.test(line)) return paint("yellow", line);
      if (/^\s{2}\S/.test(line)) return paint("dim", line);
      return line;
    })
    .join("\n");
}
