/**
 * Hover handler for text that may be truncated: shows `text` as the native tooltip only while it
 * is cut off, so a long model name can be read in full and a short one never repeats itself.
 */
export function titleWhenClipped(text: string) {
  return (event: { currentTarget: HTMLElement }) => {
    const element = event.currentTarget;
    const clipped = element.scrollWidth > element.clientWidth;
    if (clipped) element.title = text;
    else element.removeAttribute("title");
  };
}
