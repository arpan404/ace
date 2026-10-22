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

/**
 * Where offset `at` of a textarea's text is on screen, as a zero-width box one line tall: a
 * hidden copy of the field lays the text out the same way and a marker is measured in it.
 */
export function caretRect(field: HTMLTextAreaElement, at: number): DOMRect {
  const box = field.getBoundingClientRect();
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
  marker.textContent = "​";
  mirror.append(marker);
  document.body.append(mirror);
  const top = marker.offsetTop - field.scrollTop;
  const left = marker.offsetLeft - field.scrollLeft;
  const lineHeight = marker.offsetHeight || Number.parseFloat(style.lineHeight) || 16;
  mirror.remove();
  const x = box.left + Math.min(Math.max(left, 0), box.width);
  const y = box.top + Math.min(Math.max(top, 0), Math.max(box.height - lineHeight, 0));
  return new DOMRect(x, y, 0, lineHeight);
}
