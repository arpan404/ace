import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, relative, sep, parse, join } from "node:path";

export class ProjectError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
export function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
export function absoluteProjectPath(path: string): void {
  if (!isAbsolute(path) || path.includes("\0") || path.split(/[\\/]/).includes(".."))
    throw new ProjectError("invalid_path");
}
const system = [
  "/etc",
  "/private/etc",
  "/bin",
  "/sbin",
  "/usr",
  "/System",
  "/Library",
  "/dev",
  "/proc",
  "/sys",
  "/run",
  "/var",
  "/private/var",
  "/boot",
  "/Applications",
];
export function assertProjectPath(path: string, roots: readonly string[]): void {
  const normalized = path.toLowerCase();
  if (
    path === parse(path).root ||
    system.some((root) => within(root.toLowerCase(), normalized)) ||
    ["Windows", "Program Files", "Program Files (x86)", "ProgramData"].some((name) =>
      within(join(parse(path).root, name).toLowerCase(), normalized),
    )
  )
    throw new ProjectError("system_directory");
  if (!roots.some((root) => within(root, path))) throw new ProjectError("outside_project_roots");
}
/** Filesystem boundary; all policy decisions use canonical targets. */
export class ProjectPaths {
  private home: string;
  private snapshotRoots: readonly string[] | undefined;
  private configured: () => Promise<readonly string[]>;
  constructor(home: string, configured: () => Promise<readonly string[]>) {
    this.home = home;
    this.configured = configured;
  }
  /** Only already-canonical roots from roots() may enter this request-local policy. */
  static snapshot(roots: readonly string[]): ProjectPaths {
    for (const root of roots) absoluteProjectPath(root);
    const paths = new ProjectPaths("", async () => roots);
    paths.snapshotRoots = [...roots];
    return paths;
  }
  async roots(): Promise<string[]> {
    if (this.snapshotRoots !== undefined) return [...this.snapshotRoots];
    const configured = await this.configured();
    const roots = [...new Set(configured.length ? configured : [this.home])].slice(0, 32);
    return Promise.all(
      roots.map(async (root) => {
        absoluteProjectPath(root);
        return realpath(root);
      }),
    );
  }
  async directory(path: string): Promise<string> {
    absoluteProjectPath(path);
    let target: string;
    try {
      target = await realpath(path);
      assertProjectPath(target, await this.roots());
      if (!(await stat(target)).isDirectory()) throw new ProjectError("not_directory");
      await access(target, constants.R_OK | constants.X_OK);
    } catch (error) {
      if (error instanceof ProjectError) throw error;
      throw new ProjectError("directory_unavailable");
    }
    return target;
  }
}
