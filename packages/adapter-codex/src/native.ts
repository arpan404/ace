import type { RawPayload, Question, ApprovalOption } from "@ace/protocol";
import { z } from "zod";
const objectSchema = z.record(z.string(), z.unknown());
export type Obj = Record<string, unknown>;
export function obj(value: unknown): Obj {
  const decoded = objectSchema.safeParse(value);
  return decoded.success ? decoded.data : {};
}
export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
export function raw(type: string, data: unknown, name?: unknown): RawPayload[] {
  return [{ type, ...(typeof name === "string" ? { name } : {}), data }];
}
export const requestKey = (id: unknown): string => `request:${typeof id}:${String(id)}`;
export const asyncKey = (item: string): string => `async:${item}`;
export const planKey = (turn: string): string => `plan:${turn}`;
export const shellKey = (item: string): string => `shell:${item}`;
export const childKey = (thread: string): string => `subagent:${thread}`;
function option(value: unknown): Question["options"][number] {
  const native = obj(value);
  const label = str(value, str(native["label"]));
  const result: Question["options"][number] = { id: str(native["id"], label), label };
  if (typeof native["description"] === "string") result.description = native["description"];
  return result;
}
export function questions(value: unknown, async: boolean): Question[] {
  const result: Question[] = [];
  for (const [i, entry] of list(value).entries()) {
    const q = obj(entry);
    const question: Question = {
      id: str(q["id"], `q${i}`),
      text: str(q["question"], str(q["title"])),
      options: list(q["options"]).map(option),
      multiSelect: q["multiSelect"] === true,
      allowOther: async || q["isOther"] === true,
    };
    if (typeof q["header"] === "string") question.header = q["header"];
    result.push(question);
  }
  return result;
}
export function decisions(value: unknown): ApprovalOption[] {
  return list(value ?? ["accept", "acceptForSession", "decline", "cancel"]).map((entry) => {
    const id = typeof entry === "string" ? entry : (Object.keys(obj(entry))[0] ?? "cancel");
    const kind =
      id === "accept"
        ? "allow_once"
        : id === "acceptForSession"
          ? "allow_session"
          : id.startsWith("acceptWith")
            ? "allow_always"
            : id === "decline"
              ? "deny"
              : "cancel";
    return { id, label: id, kind };
  });
}
