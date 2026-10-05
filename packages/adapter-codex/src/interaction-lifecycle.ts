import { list, obj, str, type Obj } from "./native.ts";

/** History establishes transcript identity, never a live answer transport. */
export function isAsyncQuestion(item: Obj): boolean {
  return (
    item["type"] === "agentMessage" &&
    item["delivery"] === "async" &&
    list(item["questions"]).length > 0
  );
}
export function rememberHistoricalQuestions(thread: unknown, seen: Set<string>): void {
  for (const turn of list(obj(thread)["turns"]))
    for (const item of list(obj(turn)["items"])) {
      const data = obj(item);
      if (isAsyncQuestion(data)) seen.add(str(data["id"]));
    }
}
export class CodexInteractionUnavailable extends Error {
  readonly code = "interaction_unavailable";
  readonly interaction: string;
  constructor(interaction: string) {
    super("This question or approval is no longer active");
    this.name = "CodexInteractionUnavailable";
    this.interaction = interaction;
  }
}
