/** The text layout properties a mirror copies so its line breaks match the textarea's. */
const copied = [
  "boxSizing",
  "width",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "lineHeight",
  "textTransform",
  "wordSpacing",
  "tabSize",
] as const;

/** Where a text offset sits inside its field's text box, before scrolling. */
interface Offsets {
  key: string;
  top: number;
  left: number;
  lineHeight: number;
}

/**
 * The last measurement per field. The list's positioner asks for the caret on every layout
 * pass; the mirror is built again only when the text, the offset or the field's width changed.
 */
const measured = new WeakMap<HTMLTextAreaElement, Offsets>();

function offsets(field: HTMLTextAreaElement, at: number, width: number): Offsets {
  const key = `${at}:${width}:${field.value.length}:${field.value.slice(0, at)}`;
  const known = measured.get(field);
  if (known?.key === key) return known;
  const style = getComputedStyle(field);
  const mirror = document.createElement("div");
  for (const name of copied) mirror.style[name] = style[name];
  mirror.style.position = "fixed";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.textContent = field.value.slice(0, at);
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.append(marker);
  document.body.append(mirror);
  const next = {
    key,
    top: marker.offsetTop,
    left: marker.offsetLeft,
    lineHeight: marker.offsetHeight || Number.parseFloat(style.lineHeight) || 16,
  };
  mirror.remove();
  measured.set(field, next);
  return next;
}

/**
 * Where offset `at` of a textarea's text is on screen, as a zero-width box one line tall: a
 * hidden copy of the field lays the text out the same way and a marker is measured in it.
 */
export function caretRect(field: HTMLTextAreaElement, at: number): DOMRect {
  const box = field.getBoundingClientRect();
  const { top, left, lineHeight } = offsets(field, at, box.width);
  const x = box.left + Math.min(Math.max(left - field.scrollLeft, 0), box.width);
  const y =
    box.top + Math.min(Math.max(top - field.scrollTop, 0), Math.max(box.height - lineHeight, 0));
  return new DOMRect(x, y, 0, lineHeight);
}
