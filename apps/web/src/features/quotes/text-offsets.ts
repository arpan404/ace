/*
 * Where a selection sits in a rendered message, as character offsets into its text nodes, and
 * the words around it as they read.
 */

const blocks = new Set([
  "P",
  "LI",
  "PRE",
  "BLOCKQUOTE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "TD",
  "TH",
  "TR",
  "DIV",
]);

function textNodes(root: Node): Text[] {
  const nodes: Text[] = [];
  const walker = root.ownerDocument?.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker?.nextNode(); node; node = walker?.nextNode())
    if (node instanceof Text) nodes.push(node);
  return nodes;
}

/** How many characters of `root`'s text come before `offset` in `node`. */
export function textOffset(root: Node, node: Node, offset: number): number {
  const range = root.ownerDocument?.createRange();
  if (!range) return 0;
  range.setStart(root, 0);
  range.setEnd(node, offset);
  return range.toString().length;
}

/** The nearest block holding `node`, so text in two paragraphs reads with a space between. */
function blockOf(node: Node, root: Node): Node {
  let element = node.parentElement;
  while (element && element !== root && !blocks.has(element.tagName))
    element = element.parentElement;
  return element ?? root;
}

/**
 * Up to `chars` characters of the message on either side of the passage, as words read: a
 * space where one block ends and the next begins.
 */
export function contextAround(
  root: Node,
  start: number,
  end: number,
  chars: number,
): { before: string; after: string } {
  let before = "";
  let after = "";
  let seen = 0;
  let block: Node | undefined;
  for (const node of textNodes(root)) {
    const here = blockOf(node, root);
    const gap = block && here !== block ? " " : "";
    block = here;
    const text = node.data;
    const from = seen;
    seen += text.length;
    if (from < start) before += gap + text.slice(0, Math.max(0, start - from));
    if (seen > end) after += (from >= end ? gap : "") + text.slice(Math.max(0, end - from));
    if (after.length >= chars) break;
  }
  return { before: before.slice(-chars), after: after.slice(0, chars) };
}
