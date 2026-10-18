import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { requireContext } from "./errors.ts";
import { withGit, type GitProcessOptions } from "./git-process.ts";

/**
 * One `git check-ignore` process for a whole batch of workspace-relative paths.
 *
 * `--no-index` keeps the context rule that tracked files matching an ignore
 * pattern are ignored too. NUL framing carries newlines and other unusual bytes
 * in filenames. Git echoes each ignored input verbatim, so output must be a
 * subset of the input; anything else is rejected rather than trusted.
 */
export async function ignoredPaths(
  root: string,
  paths: readonly string[],
  options: GitProcessOptions,
): Promise<Set<string>> {
  if (!paths.length) return new Set();
  const asked = new Set(paths);
  const input = Buffer.from(`${[...asked].join("\0")}\0`);
  const result = await withGit(
    root,
    ["check-ignore", "--no-index", "--stdin", "-z"],
    options,
    async (child) => {
      // An early Git exit closes the pipe; its exit code reports the failure.
      child.stdin.on("error", () => {});
      child.stdin.end(input);
      const decoder = new StringDecoder("utf8");
      const ignored = new Set<string>();
      let pending = "",
        received = 0;
      for await (const chunk of child.stdout) {
        const data = z.instanceof(Buffer).parse(chunk);
        received += data.length;
        requireContext(received <= input.length, "quota", "Git response exceeded limit");
        pending += decoder.write(data);
        let end: number;
        while ((end = pending.indexOf("\0")) >= 0) {
          const path = pending.slice(0, end);
          pending = pending.slice(end + 1);
          requireContext(asked.has(path), "invalid_request", "Unexpected Git ignore response");
          ignored.add(path);
        }
      }
      requireContext(
        pending.length === 0 && decoder.end().length === 0,
        "invalid_request",
        "Incomplete Git ignore response",
      );
      return ignored;
    },
  );
  requireContext(
    result.code === 0 || result.code === 1,
    "invalid_request",
    "Cannot check workspace ignore rules",
  );
  return result.value;
}
