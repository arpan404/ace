/**
 * The page-side check for a wait_for url: the exact address, or a glob where `*` matches any
 * run of characters (`http://localhost:3000/orders/*` matches every order page). Either way the
 * document must be past loading (DOMContentLoaded).
 */
export function urlCondition(pattern: string): string {
  const ready = "document.readyState !== 'loading'";
  if (!pattern.includes("*")) return `location.href === ${JSON.stringify(pattern)} && ${ready}`;
  const source = `^${pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")}$`;
  return `new RegExp(${JSON.stringify(source)}).test(location.href) && ${ready}`;
}
