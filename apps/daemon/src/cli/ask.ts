import { cancel, confirm, isCancel, select, text } from "@clack/prompts";
import { CliFailure } from "./output.ts";
import { typedConfirms } from "./person-gate.ts";

/**
 * Questions for a person at a terminal (ADR 0178 §9), on `@clack/prompts`. Callers ask only
 * when `Args.interactive` is true; each question names the flag that would have answered it,
 * so the person learns the scripted form.
 */

function cancelled(): never {
  cancel("Nothing was changed.");
  throw new CliFailure("failed", "Cancelled.", undefined, { code: "failed" });
}

export async function askText(message: string, hint: string): Promise<string> {
  const answer = await text({
    message,
    placeholder: hint,
    validate: (value) => (value?.trim() ? undefined : "Type something, or Ctrl-C to cancel."),
  });
  if (isCancel(answer)) cancelled();
  return answer;
}

/**
 * Asks the person to type `word` to go ahead. Enter alone, or anything else, doesn't confirm;
 * Ctrl-C cancels with nothing changed.
 */
export async function askTyped(message: string, word: string): Promise<void> {
  const answer = await text({
    message,
    placeholder: `Type ${word} to go ahead, or Ctrl-C to cancel`,
    validate: (value) =>
      typedConfirms(word, value) ? undefined : `Type ${word} to go ahead, or Ctrl-C to cancel.`,
  });
  if (isCancel(answer) || !typedConfirms(word, answer)) cancelled();
}

export async function askConfirm(message: string, initialValue = false): Promise<boolean> {
  const answer = await confirm({ message, initialValue });
  if (isCancel(answer)) cancelled();
  return answer;
}

export async function askSelect<T extends string>(
  message: string,
  options: readonly { value: T; label: string; hint?: string }[],
): Promise<T> {
  const answer = await select<T>({
    message,
    options: options.map((option) => ({
      value: option.value,
      label: option.label,
      ...(option.hint ? { hint: option.hint } : {}),
    })) as Parameters<typeof select<T>>[0]["options"],
  });
  if (isCancel(answer)) cancelled();
  return answer;
}
