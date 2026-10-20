/**
 * The transcript view `thread_read` returns to agents. A daemon page carries every field the
 * app renders and replays (native payloads, execution provenance, owner and run ids, stream
 * byte counts, timestamps); an agent reading a transcript needs the words, who said them, what
 * each tool did and the ids to page, fork or continue a cut text. Everything else is dropped
 * here, item by item, so a page costs tokens in proportion to what it says.
 *
 * Kept: item `id` (fork and search refer to it), `type`, `role`, text, parts, notices'
 * level/code/title/detail, tool kind/status/detail/error/result text, delegation ids and
 * outcomes, `complete: false` on an item still streaming, and `source.streamId` on a text
 * cut short in the page (read the rest with streamId and offset).
 */
type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Fields of every item that serve the app, never an agent reading along. */
const itemNoise = new Set([
  "raw",
  "executionSource",
  "agentId",
  "runId",
  "nativeId",
  "createdAt",
  "updatedAt",
  "measurement",
  "generation",
]);
/** Fields of a tool call that repeat the item or serve the app. */
const callNoise = new Set(["raw", "id", "agentId", "startedAt", "endedAt"]);
/** Fields of a captured ace result that repeat its text or describe its capture. */
const resultNoise = new Set(["structuredContent", "durationMs", "target", "mode", "scale", "size"]);

/** One page as an agent reads it: the page's paging fields and its items, lean. */
export function agentThreadPage(page: Json): Json {
  const { itemSeqs: _seqs, seq: _seq, threadId: _thread, metadata, ...rest } = page;
  return {
    ...rest,
    ...(metadata === null || metadata === undefined ? {} : { metadata }),
    ...(Array.isArray(page["items"]) ? { items: page["items"].map(agentItem) } : {}),
  };
}

/** One transcript item without app-only fields. Unknown item types keep their own fields. */
export function agentItem(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const out: Json = {};
  for (const [key, field] of Object.entries(value)) {
    if (itemNoise.has(key)) continue;
    if (key === "complete" && field === true) continue;
    if (key === "synthetic" && field === false) continue;
    if (key === "call" && isRecord(field)) out[key] = agentCall(field);
    else if (key === "parts" && Array.isArray(field)) out[key] = field.map(agentPart);
    else if (key === "source" && isRecord(field)) {
      const source = textSource(value["text"], field);
      if (source) out[key] = source;
    } else out[key] = field;
  }
  return out;
}

function agentPart(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const { source, ...part } = value;
  const kept = isRecord(source) ? textSource(value["text"], source) : undefined;
  return kept ? { ...part, source: kept } : part;
}

/**
 * A text's stream id only when the page cut the text short: the stream holds the whole text
 * as UTF-16LE, so a preview shorter than its byte count has more to read.
 */
function textSource(text: unknown, source: Json): Json | undefined {
  const { streamId, bytes } = source;
  if (typeof streamId !== "string") return undefined;
  const shown = typeof text === "string" ? text.length * 2 : 0;
  return typeof bytes === "number" && bytes <= shown ? undefined : { streamId };
}

function agentCall(call: Json): Json {
  const out: Json = {};
  const detail = isRecord(call["detail"]) ? call["detail"] : undefined;
  for (const [key, field] of Object.entries(call)) {
    if (callNoise.has(key)) continue;
    // An MCP call's title is its tool's description; server and tool already name it.
    if (key === "title" && detail?.["kind"] === "mcp") continue;
    if (key === "result" && isRecord(field)) out[key] = agentResult(field);
    else out[key] = field;
  }
  return out;
}

function agentResult(result: Json): Json {
  return Object.fromEntries(
    Object.entries(result).filter(
      ([key, field]) => !resultNoise.has(key) && !(key === "isError" && field === false),
    ),
  );
}
