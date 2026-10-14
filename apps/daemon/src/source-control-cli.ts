import { SourceControlDraftInput, type SourceControlContext } from "@ace/protocol";
import { writingPrompt, parseWritingDraft } from "./source-control-prompt.ts";
import { draftLimits, type UtilityLimits } from "./utility-models.ts";

export interface WritingCliOptions {
  /** One short run on the utility model (`UtilityModels.generate`). */
  generate(prompt: string, signal: AbortSignal, limits: UtilityLimits): Promise<string>;
}
const failures: Record<string, string> = {
  utility_unavailable: "draft_provider_unavailable",
  utility_timeout: "draft_timeout",
  utility_provider_failed: "draft_provider_failed",
  utility_invalid_output: "draft_invalid_output",
  utility_cancelled: "draft_cancelled",
};
/** A commit or PR draft from the utility model, with its failures as fixed draft codes. */
export function createWritingCli(options: WritingCliOptions) {
  return async (
    unparsed: SourceControlDraftInput,
    context: SourceControlContext,
    threadContext: string,
    signal: AbortSignal,
  ) => {
    const input = SourceControlDraftInput.parse(unparsed);
    signal.throwIfAborted();
    let reply: string;
    try {
      reply = await options.generate(
        writingPrompt(input, context, threadContext),
        signal,
        draftLimits,
      );
    } catch (error) {
      if (signal.aborted) {
        // oxlint-disable-next-line eslint/preserve-caught-error -- External diagnostics may contain credentials.
        throw new Error("draft_cancelled");
      }
      const code = error instanceof Error ? failures[error.message] : undefined;
      // oxlint-disable-next-line eslint/preserve-caught-error -- External diagnostics may contain credentials.
      throw new Error(code ?? "draft_provider_failed");
    }
    signal.throwIfAborted();
    return parseWritingDraft(reply);
  };
}
