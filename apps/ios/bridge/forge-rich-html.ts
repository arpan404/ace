import { srcsetUrls, type HtmlNode } from "@ace/ui-core/forge-rich";
import { pixels, type InlineImage, type Run } from "./forge-rich-inline.ts";
import type { RichBlock } from "./forge-rich.ts";

/* The HTML elements of forge text that become whole blocks on the phone: pictures and tables. */

export function plain(nodes: readonly HtmlNode[]): string {
  return nodes
    .map((node) =>
      node.kind === "text" ? node.text : node.kind === "element" ? plain(node.children) : "",
    )
    .join("");
}

export function imageOf(attrs: Readonly<Record<string, string>>): InlineImage {
  return {
    src: attrs.src ?? "",
    dark: null,
    alt: attrs.alt ?? "",
    width: pixels(attrs.width),
    height: pixels(attrs.height),
  };
}

/** `<picture>`: its light image, and the dark one a `prefers-color-scheme: dark` source names. */
export function picture(node: Extract<HtmlNode, { kind: "element" }>): RichBlock[] {
  const elements = node.children.filter(
    (child): child is Extract<HtmlNode, { kind: "element" }> => child.kind === "element",
  );
  const img = elements.find((child) => child.tag === "img");
  const sources = elements.filter((child) => child.tag === "source" && child.attrs.srcset);
  const dark = sources.find((source) =>
    /prefers-color-scheme:\s*dark/i.test(source.attrs.media ?? ""),
  );
  const light = sources.find((source) =>
    /prefers-color-scheme:\s*light/i.test(source.attrs.media ?? ""),
  );
  const first = (source: typeof dark) =>
    source?.attrs.srcset ? srcsetUrls(source.attrs.srcset)[0] : undefined;
  const base = img ? imageOf(img.attrs) : undefined;
  const src = first(light) ?? base?.src ?? first(dark);
  if (!src) return [];
  return [{ k: "image", ...(base ?? imageOf({})), src, dark: first(dark) ?? null }];
}

export function tableOf(
  node: Extract<HtmlNode, { kind: "element" }>,
  runs: (children: readonly HtmlNode[]) => Run[],
): RichBlock {
  const rows: Extract<HtmlNode, { kind: "element" }>[] = [];
  const collect = (nodes: readonly HtmlNode[]) => {
    for (const child of nodes)
      if (child.kind === "element") {
        if (child.tag === "tr") rows.push(child);
        else if (child.tag === "thead" || child.tag === "tbody" || child.tag === "tfoot")
          collect(child.children);
      }
  };
  collect(node.children);
  const cells = (row: Extract<HtmlNode, { kind: "element" }>) =>
    row.children.flatMap((cell) =>
      cell.kind === "element" && (cell.tag === "td" || cell.tag === "th")
        ? [runs(cell.children)]
        : [],
    );
  const [head, ...body] = rows;
  return { k: "table", head: head ? cells(head) : [], rows: body.slice(0, 200).map(cells) };
}
