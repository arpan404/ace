export type WorkspacePreviewKind = "image" | "video";

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "ico",
  "avif",
]);

const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);

function normalizePlatform(platform?: string): string {
  if (platform) {
    return platform.toLowerCase();
  }
  if (typeof navigator === "undefined") {
    return "";
  }
  return navigator.platform.toLowerCase();
}

function extensionForPath(pathValue: string): string {
  const trimmed = pathValue.trim();
  if (trimmed.length === 0) {
    return "";
  }
  const name = trimmed.split("/").at(-1) ?? trimmed;
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex < 0 || dotIndex === name.length - 1) {
    return "";
  }
  return name.slice(dotIndex + 1).toLowerCase();
}

export function detectWorkspacePreviewKind(pathValue: string): WorkspacePreviewKind | null {
  const extension = extensionForPath(pathValue);
  if (IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    return "video";
  }
  return null;
}

export function buildWorkspacePreviewUrl(cwd: string, relativePath: string): string {
  const params = new URLSearchParams({
    cwd,
    relativePath,
  });
  return `/api/workspace-file?${params.toString()}`;
}

export function joinWorkspaceAbsolutePath(cwd: string, relativePath: string): string {
  const separator = cwd.includes("\\") ? "\\" : "/";
  const base = cwd.replace(/[\\/]+$/g, "");
  const normalizedRelative = relativePath
    .split(/[\\/]/g)
    .filter((segment) => segment.length > 0)
    .join(separator);
  return `${base}${separator}${normalizedRelative}`;
}

export function revealInFileManagerLabel(platform?: string): string {
  const normalized = normalizePlatform(platform);
  if (normalized.includes("mac")) {
    return "Reveal in Finder";
  }
  if (normalized.includes("win")) {
    return "Reveal in Explorer";
  }
  return "Reveal in File Manager";
}

export function canOpenFileExternallyFromReadError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("binary files are not supported") ||
    normalized.includes("only utf-8 text files are supported") ||
    normalized.includes("files larger than")
  );
}
