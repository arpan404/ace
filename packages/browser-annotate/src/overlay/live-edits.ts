/**
 * Style and text edits previewed on page elements while annotating (ADR 0082, phase 3).
 *
 * Every write is an inline `!important` declaration, so it wins over page rules; the element's
 * own inline value and priority are remembered first and put back exactly on revert. Text is
 * edited in the element's existing text nodes (never by replacing them), so a framework that
 * holds those nodes keeps working after the edit is reverted.
 */
// Type aliases (not interfaces) so they fit the protocol's loose record types.
export type StyleDiff = { property: string; before: string; after: string };
export type TextDiff = { before: string; after: string };

/** What one element shows now: applied property values and text. Used to roll back a session. */
export interface EditSnapshot {
  styles: Map<string, string>;
  text: string | undefined;
}

interface Inline {
  value: string;
  priority: string;
}
interface ElementEdits {
  /** The element's own inline declaration before ace touched each property. */
  inline: Map<string, Inline>;
  /** Computed value before ace touched each property. */
  computed: Map<string, string>;
  applied: Map<string, string>;
  text?:
    | { nodes: { node: Text; data: string }[]; added?: Text; before: string; value: string }
    | undefined;
}

const valueLimit = 256;
const textLimit = 4000;
/** Elements whose content is not their text: form controls, media and void elements. */
const textless = new Set([
  "input",
  "textarea",
  "select",
  "option",
  "img",
  "video",
  "audio",
  "canvas",
  "iframe",
  "object",
  "embed",
  "br",
  "hr",
  "script",
  "style",
  "svg",
  "math",
]);

/** Why the element's text can't be edited, or undefined when it can. */
export function textUnavailable(element: Element): string | undefined {
  if (!(element instanceof HTMLElement) || textless.has(element.localName))
    return "This element has no editable text";
  if (element.childElementCount > 0)
    return "Contains other elements; pick one of them to edit text";
  return undefined;
}

function noop(): void {}

function styleOf(element: Element): CSSStyleDeclaration | undefined {
  return element instanceof HTMLElement || element instanceof SVGElement
    ? element.style
    : undefined;
}

function putBack(element: Element, property: string, inline: Inline): void {
  const style = styleOf(element);
  if (!style) return;
  if (inline.value) style.setProperty(property, inline.value, inline.priority);
  else style.removeProperty(property);
}
function write(element: Element, property: string, value: string): void {
  styleOf(element)?.setProperty(property, value, "important");
}

function computedValue(element: Element, property: string): string {
  return getComputedStyle(element).getPropertyValue(property).trim().slice(0, valueLimit);
}

export function createLiveEdits() {
  const elements = new Map<Element, ElementEdits>();
  let holding = false;
  let onChange: () => void = noop;

  function entry(element: Element): ElementEdits {
    let edits = elements.get(element);
    if (!edits) {
      edits = { inline: new Map(), computed: new Map(), applied: new Map() };
      elements.set(element, edits);
    }
    return edits;
  }
  function writeText(edits: ElementEdits, value: string): void {
    const text = edits.text;
    if (!text) return;
    const [first, ...rest] = text.nodes;
    if (first) {
      first.node.data = value;
      for (const { node } of rest) node.data = "";
    } else if (text.added) text.added.data = value;
  }
  function restoreText(element: Element, edits: ElementEdits): void {
    const text = edits.text;
    if (!text) return;
    for (const { node, data } of text.nodes) node.data = data;
    if (text.added?.parentNode === element) text.added.remove();
  }
  function reapplyText(element: Element, edits: ElementEdits): void {
    const text = edits.text;
    if (!text) return;
    if (text.added && !text.added.parentNode) element.append(text.added);
    writeText(edits, text.value);
  }
  function forgetIfEmpty(element: Element, edits: ElementEdits): void {
    if (!edits.applied.size && !edits.text) elements.delete(element);
  }

  /** Preview `value` for `property`; an empty or invalid value reverts the property. */
  function set(element: Element, property: string, value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed || !CSS.supports(property, trimmed)) {
      unset(element, property);
      return !trimmed;
    }
    const style = styleOf(element);
    if (!style) return false;
    const edits = entry(element);
    if (!edits.inline.has(property)) {
      edits.inline.set(property, {
        value: style.getPropertyValue(property),
        priority: style.getPropertyPriority(property),
      });
      edits.computed.set(property, computedValue(element, property));
    }
    edits.applied.set(property, trimmed);
    if (!holding) write(element, property, trimmed);
    onChange();
    return true;
  }
  function unset(element: Element, property: string): void {
    const edits = elements.get(element);
    const inline = edits?.inline.get(property);
    if (!edits || !inline) return;
    putBack(element, property, inline);
    edits.inline.delete(property);
    edits.computed.delete(property);
    edits.applied.delete(property);
    forgetIfEmpty(element, edits);
    onChange();
  }
  /** Preview new text in a leaf element; the original text reverts it. */
  function setText(element: Element, value: string): boolean {
    if (textUnavailable(element)) return false;
    const edits = entry(element);
    if (!edits.text) {
      const nodes = [...element.childNodes].flatMap((node) =>
        node instanceof Text ? [{ node, data: node.data }] : [],
      );
      const before = element.textContent ?? "";
      edits.text = { nodes, before, value: before };
      if (!nodes.length) edits.text.added = document.createTextNode("");
    }
    const text = edits.text;
    if (value === text.before) {
      restoreText(element, edits);
      edits.text = undefined;
      forgetIfEmpty(element, edits);
      onChange();
      return true;
    }
    text.value = value.slice(0, textLimit);
    if (!holding) reapplyText(element, edits);
    onChange();
    return true;
  }
  function revert(element: Element): void {
    const edits = elements.get(element);
    if (!edits) return;
    if (!holding) {
      for (const [property, inline] of edits.inline) putBack(element, property, inline);
      restoreText(element, edits);
    }
    elements.delete(element);
    onChange();
  }

  return {
    set,
    unset,
    setText,
    revert,
    /** The text the element showed before any edit (its current text when unedited). */
    originalText(element: Element): string {
      return elements.get(element)?.text?.before ?? element.textContent ?? "";
    },
    snapshot(element: Element): EditSnapshot {
      const edits = elements.get(element);
      return {
        styles: new Map(edits?.applied ?? []),
        text: edits?.text ? edits.text.value : undefined,
      };
    },
    /** Put the element back to what `snapshot` saw, e.g. when an edit is cancelled. */
    rollback(element: Element, snapshot: EditSnapshot): void {
      const edits = elements.get(element);
      // Deleting from a Map while iterating it is safe.
      for (const property of edits?.applied.keys() ?? [])
        if (!snapshot.styles.has(property)) unset(element, property);
      for (const [property, value] of snapshot.styles) set(element, property, value);
      if (snapshot.text === undefined) {
        const current = elements.get(element);
        if (current?.text) setText(element, current.text.before);
      } else setText(element, snapshot.text);
    },
    /** Computed before and after for every previewed property, and the text change. */
    diff(element: Element): { styles: StyleDiff[]; text?: TextDiff } {
      const edits = elements.get(element);
      if (!edits) return { styles: [] };
      const styles: StyleDiff[] = [];
      for (const property of edits.applied.keys()) {
        const before = edits.computed.get(property) ?? "";
        const after = computedValue(element, property);
        if (before !== after) styles.push({ property, before, after });
      }
      const text = edits.text;
      return {
        styles: styles.slice(0, 24),
        ...(text && text.value !== text.before
          ? { text: { before: text.before.slice(0, textLimit), after: text.value } }
          : {}),
      };
    },
    edited(element: Element): boolean {
      return elements.has(element);
    },
    /** Whether any element shows a previewed edit. */
    get count(): number {
      return elements.size;
    },
    /** Show the page as it was without forgetting the edits (the bar's hold-to-view-original). */
    hold(): void {
      if (holding) return;
      holding = true;
      for (const [element, edits] of elements) {
        for (const [property, inline] of edits.inline) putBack(element, property, inline);
        restoreText(element, edits);
      }
    },
    release(): void {
      if (!holding) return;
      holding = false;
      for (const [element, edits] of elements) {
        for (const [property, value] of edits.applied) write(element, property, value);
        reapplyText(element, edits);
      }
    },
    revertAll(): void {
      holding = false;
      for (const element of elements.keys()) revert(element);
    },
    onChange(listener: () => void): void {
      onChange = listener;
    },
  };
}
export type LiveEdits = ReturnType<typeof createLiveEdits>;
