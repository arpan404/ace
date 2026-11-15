/*
 * An entity too large for the page (or snapshot) that must carry it, cut to fit instead of
 * dropped: long free text becomes its start followed by `… [cut: <n> bytes]`, and large raw
 * payloads become a marker with their size. What a reader needs to show and answer a request is
 * never cut: its kind, title, target command and options, a question's questions, an
 * elicitation's server, address, form and mode, a browser request's tab. The stored entity is
 * never changed.
 */

/** What a cut string keeps of itself. */
const keptBytes = 2 * 1024;

/** Paths under an entity that are kept whole: what shows and answers a request. */
const whole =
  /^request\.(kind|title|target\.command|options|questions|server|url|schema|mode|nativeId|tabId)(\.|$)/;

const json = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "");

/** `text` cut to its first `keep` bytes, saying it was cut and how long it was. */
function cutText(text: string, keep: number): string {
  const bytes = Buffer.byteLength(text);
  if (bytes <= keep) return text;
  const kept = Buffer.from(text).subarray(0, keep).toString("utf8").replace(/�$/, "");
  return `${kept}… [cut: ${bytes} bytes]`;
}

/** A raw payload as a marker: its type, and how large it was. */
function rawMarker(entry: unknown): unknown {
  const type =
    typeof entry === "object" && entry !== null && "type" in entry ? String(entry.type) : "raw";
  return { type: cutText(type, 256), data: `[cut: ${json(entry)} bytes]` };
}

function walk(value: unknown, path: string, keep: number): unknown {
  if (whole.test(path)) return value;
  if (typeof value === "string") return cutText(value, keep);
  if (Array.isArray(value)) {
    if (path === "raw")
      return value.map((entry) => (json(entry) > keep ? rawMarker(entry) : entry));
    return value.map((entry, index) =>
      walk(entry, path ? `${path}.${index}` : String(index), keep),
    );
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      walk(entry, path ? `${path}.${key}` : key, keep),
    ]),
  );
}

/**
 * `entity` within `bytes` of JSON if cutting can bring it there: first long text and large raw
 * payloads, then all of its raw and every cuttable text down to its marker. What is kept whole
 * is never cut, so an entity whose essentials alone are larger stays larger.
 */
export function boundedEntity<T>(entity: T, bytes: number): T {
  if (json(entity) <= bytes) return entity;
  const cut = walk(entity, "", keptBytes);
  if (json(cut) <= bytes) return cut as T;
  const record = cut as Record<string, unknown>;
  const raw = Array.isArray(record.raw) && record.raw.length ? [rawMarker(record.raw)] : record.raw;
  return walk({ ...record, ...(raw === undefined ? {} : { raw }) }, "", 0) as T;
}
