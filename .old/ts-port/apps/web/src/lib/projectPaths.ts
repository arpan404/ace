import { isExplicitRelativePath } from "@ace/shared/path";

const WINDOWS_DRIVE_ROOT_RE = /^[A-Za-z]:[\\/]*$/;
const UNC_ROOT_RE = /^[/\\]{2}[^/\\]+[/\\][^/\\]+[\\/]*$/;
const ROOT_ONLY_RE = /^[/\\]+$/;
const WINDOWS_LIKE_RE = /\\|^[A-Za-z]:/;

function resolvePathSeparator(pathValue: string): "/" | "\\" {
  return pathValue.includes("\\") && !pathValue.includes("/") ? "\\" : "/";
}

function normalizeTrailingSeparators(pathValue: string): string {
  if (
    ROOT_ONLY_RE.test(pathValue) ||
    WINDOWS_DRIVE_ROOT_RE.test(pathValue) ||
    UNC_ROOT_RE.test(pathValue)
  ) {
    return pathValue;
  }
  return pathValue.replace(/[\\/]+$/g, "");
}

function normalizeProjectPathForComparison(pathValue: string): string {
  const trimmed = pathValue.trim();
  const normalized = normalizeTrailingSeparators(trimmed).replaceAll("\\", "/");
  return WINDOWS_LIKE_RE.test(trimmed) ? normalized.toLowerCase() : normalized;
}

export function hasTrailingPathSeparator(pathValue: string): boolean {
  return /[\\/]$/.test(pathValue.trim());
}

export function appendPathSegment(pathValue: string, segment: string): string {
  const base = pathValue.trim();
  const nextSegment = segment.trim();
  if (!nextSegment) {
    return base;
  }
  if (!base) {
    return nextSegment;
  }
  if (hasTrailingPathSeparator(base)) {
    return `${base}${nextSegment}`;
  }
  return `${base}${resolvePathSeparator(base)}${nextSegment}`;
}

export function parentPath(pathValue: string): string {
  const trimmed = pathValue.trim();
  if (!trimmed) {
    return "";
  }
  if (
    trimmed === "~" ||
    ROOT_ONLY_RE.test(trimmed) ||
    WINDOWS_DRIVE_ROOT_RE.test(trimmed) ||
    UNC_ROOT_RE.test(trimmed)
  ) {
    return trimmed;
  }

  const withoutTrailing = trimmed.replace(/[\\/]+$/g, "");
  const separatorIndex = Math.max(
    withoutTrailing.lastIndexOf("/"),
    withoutTrailing.lastIndexOf("\\"),
  );
  if (separatorIndex < 0) {
    return withoutTrailing;
  }
  if (separatorIndex === 0) {
    return withoutTrailing.slice(0, 1);
  }
  if (/^[A-Za-z]:$/.test(withoutTrailing.slice(0, separatorIndex))) {
    return `${withoutTrailing.slice(0, separatorIndex)}${resolvePathSeparator(withoutTrailing)}`;
  }
  return withoutTrailing.slice(0, separatorIndex);
}

export function toBrowseDirectoryPath(pathValue: string): string {
  const trimmed = pathValue.trim();
  if (!trimmed || hasTrailingPathSeparator(trimmed)) {
    return trimmed;
  }
  return `${trimmed}${resolvePathSeparator(trimmed)}`;
}

export function resolveProjectPath(pathValue: string, cwd?: string): string {
  const trimmed = pathValue.trim();
  if (!trimmed || !cwd) {
    return trimmed;
  }
  if (!isExplicitRelativePath(trimmed)) {
    return trimmed;
  }

  const segments = trimmed.split(/[\\/]+/);
  let resolved = cwd.trim();
  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      resolved = parentPath(resolved);
      continue;
    }
    resolved = appendPathSegment(resolved, segment);
  }
  return resolved;
}

export function inferProjectTitle(pathValue: string): string {
  const trimmed = normalizeTrailingSeparators(pathValue.trim());
  if (!trimmed) {
    return "";
  }
  const segments = trimmed.split(/[\\/]/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? trimmed;
}

export function findExistingProjectByPath<T extends { cwd: string }>(
  projects: readonly T[],
  candidatePath: string,
): T | undefined {
  const normalizedCandidate = normalizeProjectPathForComparison(candidatePath);
  return projects.find(
    (project) => normalizeProjectPathForComparison(project.cwd) === normalizedCandidate,
  );
}
