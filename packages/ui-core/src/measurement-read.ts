import {
  InteractionMeasurement,
  type StepMeasurement,
  type Attachment,
  type ToolCall,
} from "@ace/protocol";
import { imagePart } from "./mcp-result.ts";

/*
 * Daemon evidence takes precedence. Older steps are read leniently from stored payloads. ace's tools
 * answer with an MCP result (one JSON text part, then the filmstrip as an image part); each
 * provider nests that result its own way (Codex's `result.content`, Claude's `tool_result`
 * blocks with Anthropic image sources), so the payloads are searched rather than addressed.
 * A payload too large to keep inline (a blob reference) has no result to read.
 */

export interface MeasurementResult {
  measurement: InteractionMeasurement;
  /** The filmstrip as a `data:` URL, when the result carried one. */
  filmstrip?: string | undefined;
  filmstripAttachment?: Attachment | undefined;
}

/** Bounds on the search: payloads are the provider's, so their size is not ours to trust. */
const maxNodes = 4096;
const maxDepth = 12;
const maxText = 256 * 1024;

/** The measurement in a text part, or `undefined` for any other text. */
function parseMeasurement(text: string): InteractionMeasurement | undefined {
  if (text.length > maxText || !text.startsWith("{") || !text.includes('"verdict"'))
    return undefined;
  try {
    const parsed = InteractionMeasurement.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Prefer daemon evidence; retain payload reading for older transcript steps. */
export function readMeasurement(
  call: Pick<ToolCall, "raw"> | undefined,
  typed?: StepMeasurement,
): MeasurementResult | undefined {
  if (typed) {
    const { filmstrip, ...measurement } = typed;
    return { measurement, ...(filmstrip ? { filmstripAttachment: filmstrip } : {}) };
  }
  if (!call) return;
  let measurement: InteractionMeasurement | undefined;
  let filmstrip: string | undefined;
  let visited = 0;
  const visit = (value: unknown, depth: number): void => {
    if (++visited > maxNodes || depth > maxDepth || (measurement && filmstrip)) return;
    if (typeof value === "string") {
      measurement ??= parseMeasurement(value);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    filmstrip ??= imagePart(value);
    for (const entry of Object.values(value)) visit(entry, depth + 1);
  };
  for (const payload of call.raw) if ("data" in payload) visit(payload.data, 0);
  if (!measurement) return undefined;
  const { filmstrip: inline, ...metrics } = measurement;
  filmstrip ??= inline && imagePart(inline);
  return { measurement: metrics, ...(filmstrip ? { filmstrip } : {}) };
}
