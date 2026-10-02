import { Item } from "@ace/protocol";
/** Pure preview policy; storage owns assigning sources and writing their bytes. */
export function textPreview(value: Item): {
  item: Item;
  target: number;
  sources: { part: number; text: string }[];
} {
  const item = Item.parse(value);
  const sources: { part: number; text: string }[] = [];
  let remaining = 4096;
  const cut = (text: string) => {
    const result = text.slice(0, remaining);
    remaining -= result.length;
    return result;
  };
  let target = 0;
  if (item.type === "message") {
    for (const [part, content] of item.parts.entries())
      if (content.type === "text") {
        sources.push({ part, text: content.text });
        content.text = cut(content.text);
      }
    target = item.parts.at(-1)?.type === "text" ? item.parts.length - 1 : item.parts.length;
  } else if (item.type === "notice" || item.type === "reasoning") {
    sources.push({ part: 0, text: item.text });
    item.text = cut(item.text);
  }
  return { item, target, sources };
}
