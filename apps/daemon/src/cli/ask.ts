import { cancel, confirm, isCancel, select, text } from "@clack/prompts";
import { CliFailure } from "./output.ts";

/**
 * Questions for a person at a terminal (ADR 0176 §9), on `@clack/prompts`. Callers ask only
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
