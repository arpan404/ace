import type { RawPayload, Question, ApprovalOption } from "@ace/protocol";
export type Obj = Record<string, unknown>;
export function obj(value: unknown): Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
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
export function questions(value: unknown, async: boolean): Question[] {
  return list(value).map((entry, i) => {
    const q = obj(entry);
    return {
      id: str(q["id"], `q${i}`),
      text: str(q["question"], str(q["title"])),
      ...(typeof q["header"] === "string" ? { header: q["header"] } : {}),
      options: list(q["options"]).map((entry) => {
        const o = obj(entry);
        const label = str(entry, str(o["label"]));
        return {
          id: label,
          label,
          ...(typeof o["description"] === "string" ? { description: o["description"] } : {}),
        };
      }),
      multiSelect: q["multiSelect"] === true,
      allowOther: async || q["isOther"] === true,
    };
  });
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
