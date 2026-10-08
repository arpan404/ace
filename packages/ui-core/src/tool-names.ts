/** "browser_open" → "browser open": a tool's or server's name as words. Pure. */
export function humanize(name: string): string {
  return name
    .replace(/^mcp__/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim()
    .toLowerCase();
}
