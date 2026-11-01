import {
  codeFileReference,
  fileTextSpans,
  type FileReference,
  type FileResolution,
} from "@ace/ui-core/file-references";

/*
 * File mentions in markit's output. markit marks every file-like code span as a reference; ace
 * links only what the thread's checkout confirms, in code spans and in running text alike, so a
 * name that isn't there reads as plain code. A settled answer's unchecked name keeps markit's
 * mark for the one lookup it takes. A confirmed mention becomes a markit reference
 * (`data-markit-reference`), whose click and Enter markit hands to `onReference`.
 */

export type Resolved = Exclude<FileResolution, { kind: "none" }>;

/** A mention found in the rendered answer: its text as written and what it points at. */
export interface FileMention {
  text: string;
  reference: FileReference;
}

const linked = "data-file-link";
/** Where a mention never links: code blocks, links, math, and mentions already linked. */
const outside = `pre, a, [role="math"], [data-tex], [${linked}]`;

/**
 * Takes markit's own file reference off the code spans `plain` picks (all of them while the
 * answer streams; on a settled answer, the names the checkout doesn't have), so they read and
 * act as plain code.
 */
export function unlinkFileCode(root: Element, plain: (text: string) => boolean): void {
  for (const code of root.querySelectorAll(`code[data-reference-kind="file"]:not([${linked}])`)) {
    if (!plain(code.textContent ?? "")) continue;
    code.removeAttribute("role");
    code.removeAttribute("tabindex");
    code.removeAttribute("data-markit-reference");
    code.removeAttribute("data-reference-kind");
  }
}

type Found =
  | { kind: "code"; node: Element; mention: FileMention }
  | { kind: "text"; node: Text; spans: ReturnType<typeof fileTextSpans> };

function collect(root: Element): Found[] {
  const found: Found[] = [];
  for (const code of root.querySelectorAll("code")) {
    if (code.closest(outside)) continue;
    const text = code.textContent ?? "";
    const reference = codeFileReference(text);
    if (reference) found.push({ kind: "code", node: code, mention: { text, reference } });
  }
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (
      !(node instanceof Text) ||
      node.parentElement?.closest(`code, [data-markit-reference], ${outside}`)
    )
      continue;
    const spans = fileTextSpans(node.data);
    if (spans.some((span) => span.kind === "file")) found.push({ kind: "text", node, spans });
  }
  return found;
}

/** Every file mention in `root` not linked yet, once each. */
export function fileMentions(root: Element): FileMention[] {
  const mentions = new Map<string, FileMention>();
  for (const entry of collect(root)) {
    if (entry.kind === "code") mentions.set(entry.mention.text, entry.mention);
    else
      for (const span of entry.spans)
        if (span.kind === "file")
          mentions.set(span.text, { text: span.text, reference: span.reference });
  }
  return [...mentions.values()];
}

function linkAttributes(element: Element, text: string, kind: Resolved["kind"], title: string) {
  element.setAttribute("role", "link");
  element.setAttribute("tabindex", "0");
  element.setAttribute("title", title);
  element.setAttribute(linked, kind);
  element.setAttribute("data-markit-reference", text);
  element.setAttribute("data-reference-kind", "file");
}

/**
 * Turns the mentions `resolved` confirms into links. `label` says what each does. Mentions it
 * doesn't know stay as they are.
 */
export function linkFileMentions(
  root: Element,
  resolved: ReadonlyMap<string, Resolved>,
  label: (mention: FileMention, resolution: Resolved) => string,
): void {
  for (const entry of collect(root)) {
    if (entry.kind === "code") {
      const resolution = resolved.get(entry.mention.text);
      if (resolution)
        linkAttributes(
          entry.node,
          entry.mention.text,
          resolution.kind,
          label(entry.mention, resolution),
        );
      continue;
    }
    if (!entry.spans.some((span) => span.kind === "file" && resolved.has(span.text))) continue;
    const document = entry.node.ownerDocument;
    const pieces = entry.spans.map((span) => {
      const resolution = span.kind === "file" ? resolved.get(span.text) : undefined;
      if (span.kind === "text" || !resolution) return document.createTextNode(span.text);
      const link = document.createElement("span");
      link.textContent = span.text;
      link.className = "cursor-pointer wrap-break-word hover:underline focus-visible:underline";
      linkAttributes(link, span.text, resolution.kind, label(span, resolution));
      return link;
    });
    entry.node.replaceWith(...pieces);
  }
}
