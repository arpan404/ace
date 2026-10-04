/*
 * Adding and managing projects: the rules the Add project dialog checks as you type (folder
 * names, clone addresses), where a path sits under the home folder, clone progress wording, and
 * what each daemon refusal means in a sentence. The daemon checks everything again; these only
 * keep a person from sending what it would refuse.
 */

/** The daemon's `ProjectName`: one folder name, no separators, traversal or control bytes. */
export function projectNameProblem(
  name: string,
  siblings: readonly string[] = [],
): string | undefined {
  if (name.length === 0) return "Give the folder a name.";
  if (name.length > 256) return "Keep the name under 256 characters.";
  if (name.includes("/") || name.includes("\\")) return "A name can't contain / or \\.";
  // oxlint-disable-next-line no-control-regex -- Folder names reject control bytes.
  if (/[\x00-\x1f]/.test(name)) return "A name can't contain control characters.";
  if (name !== name.trim()) return "Remove the spaces at the start or end.";
  if (name === "." || name === ".." || name.endsWith("."))
    return "A name can't be . or .., or end with a dot.";
  const lower = name.toLowerCase();
  if (siblings.some((sibling) => sibling.toLowerCase() === lower))
    return `There's already a folder named ${name} here.`;
  return undefined;
}

/**
 * The daemon's `ProjectCloneUrl`: HTTPS, SSH or scp-style `git@host:path`, with no password,
 * no HTTPS user name and no whitespace. ace never takes credentials, so an address carrying
 * one is refused with a pointer to the person's own Git setup. Leading and trailing spaces
 * don't count: callers send the trimmed address.
 */
export function cloneUrlProblem(url: string): string | undefined {
  const value = url.trim();
  if (!value) return "Paste the repository's address.";
  if (value.length > 4096) return "That address is too long.";
  if ([...value].some((char) => char.charCodeAt(0) < 33 || char.charCodeAt(0) === 127))
    return "Remove the spaces from the address.";
  if (value.startsWith("git@"))
    return /^git@[^/:]+:[^:]+$/.test(value)
      ? undefined
      : "Write an SSH address as git@host:owner/repo.git.";
  if (!/^(?:https:\/\/|ssh:\/\/)/.test(value))
    return value.startsWith("http://")
      ? "Use https://. ace doesn't clone over plain HTTP."
      : "Use an https://, ssh:// or git@ address.";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "That isn't a valid address.";
  }
  if (!parsed.hostname) return "The address needs a host.";
  if (parsed.password || (parsed.protocol === "https:" && parsed.username))
    return "Take the user name and password out of the address. ace clones with your own Git credentials.";
  return undefined;
}

/** "https://github.com/acme/web-app.git" → "web-app": the folder a clone suggests. */
export function repositoryName(url: string): string {
  const value = url.trim().replace(/[?#].*$/, "");
  const last =
    value
      .replace(/\/+$/, "")
      .split(/[/:]/)
      .at(-1)
      ?.replace(/\.git$/i, "") ?? "";
  return projectNameProblem(last) ? "" : last;
}

/** The folder a path names: "/Users/dev/ace" → "ace". */
export function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).at(-1) || trimmed || path;
}

/** The folder holding a path, or undefined at the root. */
export function parentFolder(path: string): string | undefined {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  if (index < 0 || trimmed === "") return undefined;
  return index === 0 ? "/" : trimmed.slice(0, index);
}

/** A child folder's path. */
export function childFolder(parent: string, name: string): string {
  return `${parent.replace(/\/+$/, "")}/${name}`;
}

export interface Crumb {
  label: string;
  path: string;
  home: boolean;
}

/**
 * The breadcrumb for a folder: from the home folder when the path is inside it (home first,
 * labelled by its name), else from the root.
 */
export function crumbs(path: string, home: string | undefined): Crumb[] {
  const normalized = path.replace(/\/+$/, "") || "/";
  const base = home?.replace(/\/+$/, "");
  if (base && (normalized === base || normalized.startsWith(`${base}/`))) {
    const rest = normalized.slice(base.length).split("/").filter(Boolean);
    return [
      { label: folderName(base), path: base, home: true },
      ...rest.map((label, index) => ({
        label,
        path: childFolder(base, rest.slice(0, index + 1).join("/")),
        home: false,
      })),
    ];
  }
  const parts = normalized.split("/").filter(Boolean);
  return [
    { label: "/", path: "/", home: false },
    ...parts.map((label, index) => ({
      label,
      path: `/${parts.slice(0, index + 1).join("/")}`,
      home: false,
    })),
  ];
}

/** A path for display, with the home folder written as ~. */
export function displayPath(path: string, home: string | undefined): string {
  const base = home?.replace(/\/+$/, "");
  if (!base) return path;
  if (path === base) return "~";
  return path.startsWith(`${base}/`) ? `~${path.slice(base.length)}` : path;
}

export type ClonePhase =
  | "starting"
  | "receiving"
  | "resolving"
  | "checkout"
  | "completed"
  | "cancelled"
  | "failed";

/**
 * A clone's progress as one bar: receiving is most of the work, resolving and checking out
 * finish it. `percent` is the phase's own progress, as Git reports it.
 */
export function cloneProgress(
  phase: ClonePhase,
  percent: number | undefined,
): { label: string; value: number | undefined } {
  const share = Math.min(100, Math.max(0, percent ?? 0)) / 100;
  switch (phase) {
    case "starting":
      return { label: "Connecting…", value: undefined };
    case "receiving":
      return { label: "Receiving objects", value: Math.round(share * 80) };
    case "resolving":
      return { label: "Resolving deltas", value: Math.round(80 + share * 12) };
    case "checkout":
      return { label: "Checking out files", value: Math.round(92 + share * 8) };
    case "completed":
      return { label: "Cloned", value: 100 };
    case "cancelled":
      return { label: "Cancelled", value: undefined };
    case "failed":
      return { label: "Clone failed", value: undefined };
  }
}

/** A daemon refusal of a project command or folder read, in a sentence a person can act on. */
export interface ProjectProblem {
  message: string;
  /** The folder can't be read here at all (outside the allowed places, or not allowed). */
  denied?: boolean;
}

const problems: Record<string, ProjectProblem> = {
  invalid_path: { message: "That isn't a folder path ace can use." },
  not_directory: { message: "That's a file, not a folder." },
  directory_unavailable: { message: "That folder doesn't exist, or ace can't read it." },
  outside_project_roots: {
    message:
      "That folder is outside the places this daemon may open. It opens folders in your home folder, or in the roots set by projects.roots.",
    denied: true,
  },
  system_directory: { message: "ace doesn't open system folders.", denied: true },
  forbidden: {
    message:
      "This device isn't allowed to manage projects. Pair it again and allow access to projects.",
    denied: true,
  },
  destination_not_empty: { message: "A folder with that name already exists here." },
  destination_not_directory: { message: "A file already has that name here." },
  directory_too_large: { message: "This folder has too many entries to list." },
  project_busy: { message: "Another project is being set up in that folder right now." },
  project_path_changed: { message: "The folder changed while ace was adding it. Try again." },
  projects_closed: { message: "The daemon is shutting down. Try again once it's back." },
  workspace_not_found: { message: "That project is gone." },
  workspace_threads_running: { message: "Threads in this project are still running." },
  clone_cancelled: { message: "Clone cancelled." },
  clone_not_repository: { message: "That address didn't give a Git repository." },
  clone_not_running: { message: "That clone has already finished." },
  git_auth_failed: {
    message:
      "Git couldn't sign in to that repository. ace uses your own Git credentials: check that you can clone it in a terminal on the daemon's machine (an SSH key or a credential helper), then try again.",
  },
  git_invalid_argument: {
    message: "Use an https://, ssh:// or git@ address, without a user name or password in it.",
  },
  git_invalid_ref: { message: "That isn't a valid branch name." },
  git_timeout: { message: "Git took too long. Check the network and try again." },
  git_missing: { message: "Git isn't installed on the daemon's machine." },
  git_too_old: { message: "ace needs Git 2.40 or newer on the daemon's machine." },
  git_failed: {
    message: "Git couldn't finish. Check the address and that the daemon's machine can reach it.",
  },
  git_cancelled: { message: "Cancelled." },
  busy: { message: "Too many folder reads at once. Try again in a moment." },
  unavailable: { message: "This daemon can't manage projects yet. Update ace on that machine." },
  projects_unavailable: {
    message: "This daemon can't manage projects yet. Update ace on that machine.",
  },
  not_implemented: {
    message: "This daemon can't manage projects yet. Update ace on that machine.",
  },
};

export function projectProblem(code: string): ProjectProblem {
  return problems[code] ?? { message: "Something went wrong. Try again." };
}
