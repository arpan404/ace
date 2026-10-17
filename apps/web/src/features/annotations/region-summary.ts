/** What a region holds, for a list row: `button "Get started", p "Cancel any time"`. */
export function regionContents(elements: readonly { tag: string; text: string }[]): string {
  return elements
    .map((element) => {
      const text = element.text.replace(/\s+/g, " ").trim();
      return `${element.tag.toLowerCase()}${text ? ` “${text}”` : ""}`;
    })
    .join(", ");
}

/** The badge a row shows: the element's tag, or "region" for a dragged-out area. */
export const badgeFor = (kind: string, tag: string) => (kind === "region" ? "region" : tag);
