/** File paths are data, never URL query/fragment syntax. Keep separators and drive letters. */
export function editorFilePath(path: string): string {
  const normalized = /^[A-Za-z]:[\\/]/.test(path) ? `/${path.replaceAll("\\", "/")}` : path;
  return normalized
    .split("/")
    .map((segment, index) =>
      index === 1 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment),
    )
    .join("/");
}
