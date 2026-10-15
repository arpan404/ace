import { z } from "zod";
import type { RpcId } from "@ace/provider-kit/jsonrpc";

export type LineAttribution = { id?: RpcId; threadId?: string; response: boolean };
const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

/** Inspect complete tokens in the gate's bounded prefix, never text inside an unfinished string. */
export function attributeDroppedLine(prefix: string): LineAttribution {
  const result: LineAttribution = { response: false };
  const token =
    /\s*("(?:\\.|[^"\\])*"|[{}[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/y;
  const path: string[] = [];
  let key = "";
  let previous = "";
  let lastString = "";
  let method = false;
  for (let offset = 0; offset < prefix.length;) {
    token.lastIndex = offset;
    const match = token.exec(prefix);
    if (!match) break;
    offset = token.lastIndex;
    const value = match[1] ?? "";
    if (/^[-\dtfn]/.test(value) && !/^[\s,}\]]/.test(prefix.slice(offset))) break;
    if (value === ":") {
      key = lastString;
      if (path.length === 1 && ["result", "error"].includes(key)) result.response = true;
    } else if (value === "{" || value === "[") {
      if (path.length === 1 && previous === ":" && ["result", "error"].includes(key))
        result.response = true;
      path.push(previous === ":" ? key : "");
    } else if (value === "}" || value === "]") path.pop();
    else if (value !== ",") {
      let decoded: unknown;
      try {
        decoded = JSON.parse(value);
      } catch {
        break;
      }
      const parsed = scalar.safeParse(decoded);
      if (!parsed.success) break;
      if (previous === ":") {
        if (path.length === 1) {
          if (key === "id" && (typeof parsed.data === "string" || typeof parsed.data === "number"))
            result.id = parsed.data;
          if (key === "method") method = true;
          if (["result", "error"].includes(key)) result.response = true;
        }
        if (
          path.length === 2 &&
          path[1] === "params" &&
          key === "threadId" &&
          typeof parsed.data === "string"
        )
          result.threadId = parsed.data;
      }
      lastString = typeof parsed.data === "string" ? parsed.data : "";
    }
    previous = value;
  }
  result.response &&= !method;
  return result;
}
