/** Frontmatter is metadata; the first heading may supply a human component title. */
export function componentBody(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
}
export function componentTitle(text: string, name: string): string | undefined {
  const title = /^# ([^\r\n]{1,200})(?:\r?\n|$)/.exec(componentBody(text).trimStart())?.[1]?.trim();
  return title && title !== name ? title : undefined;
}
