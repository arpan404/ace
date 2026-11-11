import type { ContentPart } from "@ace/protocol";

/**
 * Where the person put each file in their message (`MessageContext.attachments[].at`).
 *
 * Placement runs in two steps because the message's text can change in between: catalog
 * mentions are translated and coalesced, and browser tabs append their blocks. `markPlaces`
 * splits the person's text at each offset and leaves a placeholder part there; whatever
 * rewrites the text keeps non-text parts in order. `fillPlaces` then swaps each placeholder
 * for the file's prepared part and appends every other prepared part after the message, as
 * an unpositioned file has always been sent.
 */
export interface Places {
  /** Placeholder path to the files (indexes into the message's attachments) at that spot. */
  slots: ReadonlyMap<string, Slot>;
}
interface Slot {
  files: number[];
  /** The spot splits one text part: text sits directly before and after it. */
  before: boolean;
  after: boolean;
}
const prefix = "ace-slot:";
/** Mention translation and Pi's input both refuse a message of more parts. */
const maxParts = 256;
const none: Places = { slots: new Map() };

function high(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
function low(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Split the person's text at each file's offset (UTF-16 units into the text parts joined in
 * order) and leave a placeholder there. Offsets past the end clamp to the end; an offset inside
 * a surrogate pair, even one split across parts, moves to the pair's start. A catalog mention
 * adds no text, so a file at its edge goes before it, also in a message of only mentions.
 * Without offsets, or when the spots would take the message past the part limit, the input is
 * unchanged and the files go after the text.
 */
export function markPlaces(
  input: readonly ContentPart[],
  offsets: readonly (number | undefined)[],
): { input: ContentPart[]; places: Places } {
  const texts: { index: number; start: number; text: string }[] = [];
  let length = 0;
  for (const [index, part] of input.entries()) {
    // A part already shaped like a placeholder would be mistaken for one: keep today's order.
    if (part.type === "file" && part.path.startsWith(prefix))
      return { input: [...input], places: none };
    if (part.type !== "text") continue;
    texts.push({ index, start: length, text: part.text });
    length += part.text.length;
  }
  const positioned = offsets
    .map((at, file) => ({ at, file }))
    .filter((entry): entry is { at: number; file: number } => entry.at !== undefined);
  // Each spot adds a placeholder and may split a text part in two.
  if (!positioned.length || input.length + 2 * positioned.length > maxParts)
    return { input: [...input], places: none };
  // Without text every offset is the start: a message that opens with mentions takes its files
  // before them; any other message sends them after, as today.
  if (!texts.length) {
    if (input[0]?.type !== "mention") return { input: [...input], places: none };
    const path = `${prefix}0`;
    const files = positioned.map((entry) => entry.file);
    return {
      input: [{ type: "file", path }, ...input],
      places: { slots: new Map([[path, { files, before: false, after: false }]]) },
    };
  }
  // Stable: files at the same offset keep the order they were attached in.
  positioned.sort((a, b) => Math.min(a.at, length) - Math.min(b.at, length));
  const cuts = new Map<number, Map<number, number[]>>();
  const leading = new Map<number, number[]>();
  // A pair can span two text parts, so surrogates are checked against the joined text.
  const joined = texts.map((text) => text.text).join("");
  for (const { at, file } of positioned) {
    let x = Math.min(at, length);
    if (x > 0 && x < length && high(joined.charCodeAt(x - 1)) && low(joined.charCodeAt(x))) x--;
    const owner = texts.find((text) => x <= text.start + text.text.length);
    if (!owner) continue;
    const k = x - owner.start;
    let before = owner.index;
    if (k === 0) while (input[before - 1]?.type === "mention") before--;
    if (before < owner.index) {
      leading.set(before, [...(leading.get(before) ?? []), file]);
      continue;
    }
    const part = cuts.get(owner.index) ?? new Map<number, number[]>();
    cuts.set(owner.index, part);
    part.set(k, [...(part.get(k) ?? []), file]);
  }
  const slots = new Map<string, Slot>();
  const output: ContentPart[] = [];
  for (const [index, part] of input.entries()) {
    const ahead = leading.get(index);
    if (ahead) {
      const path = `${prefix}${slots.size}`;
      slots.set(path, { files: ahead, before: false, after: false });
      output.push({ type: "file", path });
    }
    const at = cuts.get(index);
    if (!at || part.type !== "text") {
      output.push(part);
      continue;
    }
    let cursor = 0;
    for (const k of [...at.keys()].toSorted((a, b) => a - b)) {
      if (k > cursor) output.push({ type: "text", text: part.text.slice(cursor, k) });
      const path = `${prefix}${slots.size}`;
      slots.set(path, { files: at.get(k) ?? [], before: k > 0, after: k < part.text.length });
      output.push({ type: "file", path });
      cursor = k;
    }
    if (cursor < part.text.length) output.push({ type: "text", text: part.text.slice(cursor) });
  }
  return { input: output, places: { slots } };
}

function kind(part: ContentPart): string {
  const mime = part.type === "image" || part.type === "file" ? (part.mimeType ?? "") : "";
  if (part.type === "image" || mime.startsWith("image/")) return "image";
  return mime === "application/pdf" ? "PDF" : "file";
}

/**
 * Replace each placeholder with its files and append the rest of the prepared context.
 *
 * `interleaved` providers keep part order in their native message, so each file's own part
 * goes at its spot. Others join a message's text into one prompt and send files beside it:
 * a file that became text joins the text at its spot on lines of its own, and a native file is
 * named there (`[Attached image 1: screen.png]`, numbered in the order files reach the provider) and sent
 * after the text.
 */
export function fillPlaces(
  message: readonly ContentPart[],
  places: Places,
  context: readonly ContentPart[],
  /** Per message attachment: its part in `context` and its name. */
  files: readonly ({ part: number; name: string } | undefined)[],
  interleaved: boolean,
): ContentPart[] {
  const present = message.filter(
    (part) => part.type === "file" && places.slots.has(part.path),
  ).length;
  if (!present) return [...message, ...context];
  const placed = new Set<number>();
  const labelled = new Set<number>();
  for (const part of message) {
    const slot = part.type === "file" ? places.slots.get(part.path) : undefined;
    for (const file of slot?.files ?? []) {
      const index = files[file]?.part;
      const prepared = index === undefined ? undefined : context[index];
      if (index === undefined || !prepared) continue;
      if (interleaved || prepared.type === "text") placed.add(index);
      else labelled.add(index);
    }
  }
  const trailing = context.filter((_part, index) => !placed.has(index));
  const labels = new Map<number, string>();
  const counts = new Map<string, number>();
  // Numbers follow native delivery order: files already in the message go before the context.
  for (const part of message) {
    if (part.type !== "image" && part.type !== "file") continue;
    if (part.type === "file" && places.slots.has(part.path)) continue;
    counts.set(kind(part), (counts.get(kind(part)) ?? 0) + 1);
  }
  for (const [index, part] of context.entries()) {
    if (placed.has(index) || part.type === "text") continue;
    const word = kind(part);
    const count = (counts.get(word) ?? 0) + 1;
    counts.set(word, count);
    if (labelled.has(index)) {
      const name = files.find((file) => file?.part === index)?.name;
      labels.set(index, `[Attached ${word} ${count}${name ? `: ${name}` : ""}]`);
    }
  }
  const output: ContentPart[] = [];
  let joining: { type: "text"; text: string } | undefined;
  for (const part of message) {
    const slot = part.type === "file" ? places.slots.get(part.path) : undefined;
    if (!slot) {
      if (joining && part.type === "text") joining.text += part.text;
      else output.push(part);
      joining = undefined;
      continue;
    }
    const last = output.at(-1);
    let current: { type: "text"; text: string } | undefined;
    if (slot.before && last?.type === "text") {
      current = { type: "text", text: last.text };
      output[output.length - 1] = current;
    }
    for (const file of slot.files) {
      const index = files[file]?.part;
      const prepared = index === undefined ? undefined : context[index];
      if (index === undefined || !prepared) continue;
      const label =
        labels.get(index) ??
        (!interleaved && prepared.type === "text" ? `\n${prepared.text}\n` : undefined);
      if (label === undefined) {
        output.push(prepared);
        current = undefined;
      } else if (current) current.text += label;
      else {
        current = { type: "text", text: label };
        output.push(current);
      }
    }
    joining = slot.after ? current : undefined;
  }
  return [...output, ...trailing];
}
