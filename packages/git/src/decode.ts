import { isAbsolute } from "node:path";
import { z } from "zod";
import { GitError } from "./types.ts";

export const hashSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const modeSchema = z.enum(["000000", "040000", "100644", "100755", "120000", "160000"]);
export const pathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.includes("\0") &&
      !isAbsolute(path) &&
      path
        .split("/")
        .every(
          (part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git",
        ),
  );
export const absolutePathSchema = z
  .string()
  .min(1)
  .refine((path) => isAbsolute(path) && !path.includes("\0"));
export const refSchema = z
  .string()
  .min(1)
  .refine(
    (ref) =>
      ![...ref].some(
        (char) =>
          char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127 || "~^:?*[\\".includes(char),
      ) &&
      !ref.includes("..") &&
      !ref.includes("@{") &&
      ref
        .split("/")
        .every(
          (part) =>
            part !== "" && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock"),
        ),
  );
export function decode<T>(schema: z.ZodType<T>, value: unknown, context: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw malformed(context);
  return result.data;
}
export function malformed(context: string): GitError {
  return new GitError("malformed_output", `Malformed Git ${context}`);
}
export function hash(value: unknown): string {
  return decode(hashSchema, value, "object hash");
}
export function count(value: unknown): number {
  const digits = decode(z.string().regex(/^\d+$/), value, "count");
  return decode(
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    Number(digits),
    "count",
  );
}
export function nul(buffer: Buffer): string[] {
  if (!buffer.length) return [];
  if (buffer.at(-1) !== 0) throw malformed("NUL framing");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw malformed("UTF-8 metadata");
  }
  const records = text.split("\0");
  records.pop();
  return records;
}
export class Records {
  private position = 0;
  private readonly records: string[];
  constructor(records: string[]) {
    this.records = records;
  }
  peek(): string | undefined {
    return this.records[this.position];
  }
  next(): string {
    const record = this.records[this.position++];
    if (record === undefined) throw malformed("record arity");
    return record;
  }
  done(): boolean {
    return this.position === this.records.length;
  }
}
export function fieldsAndPath(
  record: string,
  fieldCount: number,
): { fields: string[]; path: string } {
  let offset = 0;
  const fields: string[] = [];
  for (let i = 0; i < fieldCount; i++) {
    const space = record.indexOf(" ", offset);
    if (space < 0) throw malformed("record arity");
    fields.push(record.slice(offset, space));
    offset = space + 1;
  }
  return { fields, path: decode(pathSchema, record.slice(offset), "path") };
}

export function pathAncestors(path: string): string[] {
  const parts = path.split("/");
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}
