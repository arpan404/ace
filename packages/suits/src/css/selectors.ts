import { generate, type CssNode, type Selector, type SelectorList } from "css-tree";
import { protectedSuitParts, suitPages, suitParts, type SuitPart } from "@ace/protocol/suit-parts";

/*
 * Which selectors a Suit's CSS may use (ADR 0150, "suit.css"): built only from the published
 * parts and their state attributes, never a class, id or element, and always ending on a part,
 * so every rule names what it styles. Pure: takes css-tree nodes, returns a verdict.
 */

const known = new Set<string>(suitParts);
const pages = new Set<string>(suitPages);
const guarded = new Set<string>(protectedSuitParts);
const stateAttributes = new Set(["data-state", "data-variant", "data-scheme"]);
const attributeValue = /^[a-z0-9-]{1,40}$/;

const pseudoClasses = new Set([
  "hover",
  "focus",
  "focus-visible",
  "focus-within",
  "active",
  "disabled",
  "enabled",
  "checked",
  "empty",
  "placeholder-shown",
  "first-child",
  "last-child",
  "only-child",
  "first-of-type",
  "last-of-type",
  "only-of-type",
  "nth-child",
  "nth-last-child",
  "nth-of-type",
  "nth-last-of-type",
]);
/** Pseudo-classes that take selectors, checked by the same rules. */
const selectorPseudoClasses = new Set(["not", "is", "where", "has"]);
const pseudoElements = new Set([
  "before",
  "after",
  // An answer's opening letter, for drop caps and illuminated initials.
  "first-letter",
  "placeholder",
  "selection",
  "-webkit-scrollbar",
  "-webkit-scrollbar-thumb",
  "-webkit-scrollbar-track",
  "-webkit-scrollbar-track-piece",
  "-webkit-scrollbar-corner",
  "-webkit-scrollbar-button",
]);

export interface CheckedSelector {
  /** The parts the rule's subject can be; any protected one limits its declarations. */
  parts: Set<SuitPart>;
  /** The selector scoped to `[data-suit="<id>"]`. */
  scoped: string;
}

export type SelectorVerdict =
  | { ok: true; selectors: CheckedSelector[] }
  | { ok: false; reason: string };

const isPart = (name: string): name is SuitPart => known.has(name);

function attributeText(node: Extract<CssNode, { type: "AttributeSelector" }>): string | undefined {
  const value = node.value;
  if (!value) return undefined;
  return value.type === "String" ? value.value : value.name;
}

/** The parts a compound names (directly or through `:is`/`:where`), or a reason it can't be used. */
function checkCompound(nodes: readonly CssNode[], parts: Set<SuitPart>): string | undefined {
  for (const node of nodes) {
    switch (node.type) {
      case "AttributeSelector": {
        const name = node.name.name.toLowerCase();
        const value = attributeText(node);
        if (name === "data-part") {
          if (node.matcher !== "=" || value === undefined)
            return "a part is selected only as [data-part=<name>]";
          if (!isPart(value)) return `"${value}" is not a published part (see suit-parts)`;
          if (node.flags) return "a part name takes no flags";
          parts.add(value);
          break;
        }
        if (name === "data-page") {
          if (node.matcher !== "=" || value === undefined || !pages.has(value))
            return "a page is selected only as [data-page=<name>] with a published page (see suit-parts)";
          break;
        }
        if (!stateAttributes.has(name))
          return `[${name}] is not part of the styling contract; use data-part, data-page, data-state, data-variant or data-scheme`;
        if (value !== undefined && !attributeValue.test(value))
          return `[${name}] takes a short lower-case value`;
        break;
      }
      case "PseudoClassSelector": {
        const name = node.name.toLowerCase();
        if (selectorPseudoClasses.has(name)) {
          const inner = node.children?.first;
          if (!inner || inner.type !== "SelectorList") return `:${name}() needs selectors`;
          const nested = new Set<SuitPart>();
          const reason = checkList(inner, nested, name === "has");
          if (reason) return reason;
          // A part named under :is() or :where() is what the subject is; under :not() or :has()
          // it isn't.
          if (name === "is" || name === "where") for (const part of nested) parts.add(part);
          break;
        }
        if (!pseudoClasses.has(name)) return `:${name} is not an allowed pseudo-class`;
        if (node.children) {
          for (const child of node.children) {
            if (child.type !== "Nth") return `:${name}() takes only an An+B formula`;
            if (child.selector) {
              const reason = checkList(child.selector, new Set(), false);
              if (reason) return reason;
            }
          }
        }
        break;
      }
      case "PseudoElementSelector": {
        const name = node.name.toLowerCase();
        if (!pseudoElements.has(name)) return `::${name} is not an allowed pseudo-element`;
        break;
      }
      case "TypeSelector":
        return node.name === "*"
          ? "the universal selector reaches parts that aren't published; name a part"
          : `"${node.name}" names an element; select a [data-part] instead`;
      case "ClassSelector":
        return `".${node.name}" names a class; classes aren't part of the styling contract`;
      case "IdSelector":
        return `"#${node.name}" names an id; ids aren't part of the styling contract`;
      case "NestingSelector":
        return "nested rules (&) aren't supported; write each rule in full";
      default:
        return `this selector isn't supported (${node.type})`;
    }
  }
  return undefined;
}

/** Splits a selector into compounds at its combinators. */
function compounds(selector: Selector): { nodes: CssNode[]; combinator: string | undefined }[] {
  const result: { nodes: CssNode[]; combinator: string | undefined }[] = [
    { nodes: [], combinator: undefined },
  ];
  for (const node of selector.children) {
    if (node.type === "Combinator") result.push({ nodes: [], combinator: node.name });
    else result.at(-1)?.nodes.push(node);
  }
  return result;
}

function checkSelector(
  selector: Selector,
  subject: Set<SuitPart>,
  relative: boolean,
): string | undefined {
  const pieces = compounds(selector);
  for (const [index, piece] of pieces.entries()) {
    // `:has(> [data-part=x])` starts on a combinator: the first compound is empty.
    if (piece.nodes.length === 0 && !(relative && index === 0)) return "a selector is empty";
    const parts = new Set<SuitPart>();
    const reason = checkCompound(piece.nodes, parts);
    if (reason) return reason;
    if (index === pieces.length - 1) for (const part of parts) subject.add(part);
  }
  return undefined;
}

function checkList(
  list: SelectorList,
  subject: Set<SuitPart>,
  relative: boolean,
): string | undefined {
  for (const selector of list.children) {
    if (selector.type !== "Selector") return "this selector isn't supported";
    const parts = new Set<SuitPart>();
    const reason = checkSelector(selector, parts, relative);
    if (reason) return reason;
    if (parts.size === 0 && !relative) return "every selector must end on a [data-part]";
    for (const part of parts) subject.add(part);
  }
  return undefined;
}

const schemeOnly = (nodes: readonly CssNode[]) =>
  nodes.length > 0 &&
  nodes.every(
    (node) => node.type === "AttributeSelector" && node.name.name.toLowerCase() === "data-scheme",
  );

/**
 * `selector` under the Suit's own scope. `[data-scheme]` lives on the same element as
 * `[data-suit]`, so a leading scheme-only compound joins the scope rather than nesting under it.
 */
function scope(selector: Selector, id: string): string {
  const root = `[data-suit="${id}"]`;
  const pieces = compounds(selector);
  const join = (from: number) =>
    pieces
      .slice(from)
      .map((piece, index) =>
        index === 0 && from === 0
          ? text(piece.nodes)
          : `${combinatorText(piece.combinator)}${text(piece.nodes)}`,
      )
      .join("");
  const first = pieces[0];
  if (first && schemeOnly(first.nodes) && pieces.length > 1)
    return `${root}${text(first.nodes)}${join(1)}`;
  return `${root} ${join(0)}`;
}

const text = (nodes: readonly CssNode[]) => nodes.map((node) => generate(node)).join("");
const combinatorText = (name: string | undefined) =>
  name === undefined || name === " " || name === "" ? " " : `${name}`;

/** The rule's selectors checked and scoped, or why the rule can't be used. */
export function checkSelectors(list: CssNode | null, id: string): SelectorVerdict {
  if (!list || list.type !== "SelectorList")
    return { ok: false, reason: "this rule's selector doesn't parse" };
  const selectors: CheckedSelector[] = [];
  for (const selector of list.children) {
    if (selector.type !== "Selector")
      return { ok: false, reason: "this rule's selector doesn't parse" };
    const parts = new Set<SuitPart>();
    const reason = checkSelector(selector, parts, false);
    if (reason) return { ok: false, reason };
    if (parts.size === 0) return { ok: false, reason: "every selector must end on a [data-part]" };
    selectors.push({ parts, scoped: scope(selector, id) });
  }
  return { ok: true, selectors };
}

export const touchesProtected = (parts: ReadonlySet<SuitPart>) =>
  [...parts].some((part) => guarded.has(part));
