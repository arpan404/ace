import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * A Windows launcher for a fake provider CLI, shaped like the `.cmd` shim npm installs:
 * cmd.exe runs it and it forwards every argument to Node running `script`. Launching a fake
 * through it takes the same batch path (cmd.exe wrapping, `%*` reparse) as a real install.
 */
export async function writeCmdShim(
  directory: string,
  name: string,
  script: string,
  node: string = process.execPath,
): Promise<string> {
  // A quote or % would be reparsed by cmd.exe instead of reaching Node as a path.
  if (/["%]/.test(node + script)) throw new Error("A cmd shim path cannot contain a quote or %");
  const path = join(directory, `${name}.cmd`);
  await writeFile(path, `@"${node}" "${script}" %*\r\n`);
  return path;
}
