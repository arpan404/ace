export function formatCommandDisplayLabel(name: string): string {
  return name
    .trim()
    .replace(/^[/@$]+/, "")
    .split(/[-_.:\s/]+/u)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
