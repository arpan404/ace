import type { RawPayload } from "@ace/protocol";

/*
 * What an MCP tool answered, read from the provider's stored payloads. Every provider nests the
 * result its own way (Codex's `result.content` and `error.message`, Claude's `tool_result`
 * blocks with Anthropic image sources), so the payloads are searched rather than addressed, with
 * bounds: they are the provider's, so their size is not ours to trust. A payload too large to
 * keep inline (a blob reference) has no result to read. Pure.
 */

const maxNodes = 4096;
const maxDepth = 12;
/** Text parts longer than this are not ace's small JSON answers and are skipped. */
const maxText = 256 * 1024;

export const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

/** An image part as a `data:` URL: MCP's `{ data, mimeType }` or Anthropic's `source`. */
export function imagePart(value: unknown): string | undefined {
  if (field(value, "type") !== "image") return undefined;
  const source = field(value, "source") ?? value;
  const data = field(source, "data");
  const mimeType = field(source, "mimeType") ?? field(source, "media_type");
  if (typeof data !== "string" || typeof mimeType !== "string") return undefined;
  if (!/^image\/(jpeg|png|webp)$/.test(mimeType) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
    return undefined;
  return `data:${mimeType};base64,${data}`;
}

export interface McpResultParts {
  /** Image parts as `data:` URLs, in order, without repeats. */
  images: string[];
  /** Text parts, error messages and string tool results, in order. */
  texts: string[];
}

/** The text and image parts of a tool's stored result, at most `maxImages` images. */
export function mcpResultParts(raw: readonly RawPayload[], maxImages = 4): McpResultParts {
  const images: string[] = [];
  const texts: string[] = [];
  let visited = 0;
  const visit = (value: unknown, depth: number): void => {
    if (++visited > maxNodes || depth > maxDepth) return;
    if (typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    const image = imagePart(value);
    if (image) {
      if (images.length < maxImages && !images.includes(image)) images.push(image);
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "string") {
        if ((key === "text" || key === "message" || key === "content") && entry.length <= maxText)
          texts.push(entry);
      } else visit(entry, depth + 1);
    }
  };
  for (const payload of raw) if ("data" in payload) visit(payload.data, 0);
  return { images, texts };
}

/** ace's public tool failure (`{ code, message, hint }`), as the MCP server words it. */
export interface McpFailure {
  code: string;
  message?: string | undefined;
  hint?: string | undefined;
}

/** A JSON object with a string `code` in `text`, as ace's MCP server answers a failure. */
function failureIn(text: string): McpFailure | undefined {
  const start = text.indexOf("{");
  if (start < 0 || !text.includes('"code"')) return undefined;
  try {
    const parsed: unknown = JSON.parse(text.slice(start));
    const code = field(parsed, "code");
    if (typeof code !== "string" || !/^[a-z][a-z_.]{0,63}$/.test(code)) return undefined;
    const message = field(parsed, "message");
    const hint = field(parsed, "hint");
    return {
      code,
      message: typeof message === "string" ? message : undefined,
      hint: typeof hint === "string" ? hint : undefined,
    };
  } catch {
    return undefined;
  }
}

/** The failure a tool answered with, from its error or its result's text parts. */
export function mcpFailure(
  texts: readonly string[],
  error?: string | undefined,
): McpFailure | undefined {
  for (const text of error ? [error, ...texts] : texts) {
    const failure = failureIn(text);
    if (failure) return failure;
  }
  return undefined;
}
