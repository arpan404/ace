import {
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";

/** Session-owned credential storage. Never write a provider's persistent or project config. */
export function privateMcpConfig(content: string, workspace?: string) {
  if (Buffer.byteLength(content) > 256 * 1024) throw new Error("MCP configuration exceeds limit");
  const root = tmpdir();
  if (workspace) {
    const path = relative(workspace, root);
    if (!path || (!path.startsWith("..") && !isAbsolute(path)))
      throw new Error("MCP credential directory must be outside the workspace");
  }
  const directory = mkdtempSync(join(root, "ace-mcp-"));
  const path = join(directory, "config.json");
  try {
    chmodSync(directory, 0o700);
    writeFileSync(path, content, { mode: 0o600, flag: "wx" });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return { path, remove: () => rmSync(directory, { recursive: true, force: true }) };
}

/** Read only a bounded private regular file, with symlinks rejected at open. */
export function readPrivateMcpConfig(path: string): string {
  if (process.platform === "win32") return readWindowsPrivateMcpConfig(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 256 * 1024 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Invalid private MCP configuration");
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Windows has no mode bits or O_NOFOLLOW: the per-user temp folder's ACL keeps the file private,
 * links are refused before open and the opened file must be the same regular file.
 */
function readWindowsPrivateMcpConfig(path: string): string {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile()) throw new Error("Invalid private MCP configuration");
  const fd = openSync(path, constants.O_RDONLY);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (
      !stat.isFile() ||
      stat.ino !== before.ino ||
      stat.dev !== before.dev ||
      stat.size > 256n * 1024n
    )
      throw new Error("Invalid private MCP configuration");
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}
