import type { GitCli } from "./cli.ts";
import { hash, nul } from "./decode.ts";
import { GitError } from "./types.ts";
import { incompletePublicationScan, inspectPublicationBatch, objectHeader,
  sensitivePublicationPath, type ScanObject } from "./publication-sensitive.ts";

const metadataLimit = 8 * 1024 * 1024;
const contentLimit = 128 * 1024 * 1024;
const objectLimit = 8 * 1024 * 1024;
/** Scan a pinned commit using bounded Git object reads. Unknown remote tips are never excluded. */
export async function scanPublication(cli: GitCli, input: {
  worktree: string; directoryFd: number; signal: AbortSignal; head: string; url: string;
  transport: readonly string[]; guard?: () => void;
}): Promise<void> {
  const read = async (args: string[], stdin?: string, capacity = metadataLimit) => {
    input.guard?.(); input.signal.throwIfAborted();
    const result = await cli.call(input.worktree, args, {
      directoryFd: input.directoryFd, signal: input.signal, captureBytes: capacity,
      ...(stdin === undefined ? {} : { input: stdin }),
      env: { GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" },
    });
    input.guard?.();
    if (result.truncated) incompletePublicationScan();
    return result.stdout;
  };
  if ((await read(["rev-parse", "--is-shallow-repository"])).toString("ascii").trim() !== "false") incompletePublicationScan();
  const advertised = (await read([...input.transport, "ls-remote", "--", input.url])).toString("utf8").trim();
  const tips = [...new Set(advertised ? advertised.split("\n").map((line) => hash(line.split("\t")[0])) : [])];
  if (tips.length > 2000) incompletePublicationScan();
  const known: string[] = [];
  if (tips.length) {
    const rows = (await read(["cat-file", "--batch-check"], tips.join("\n") + "\n")).toString("ascii").trim().split("\n");
    if (rows.length !== tips.length) incompletePublicationScan();
    rows.forEach((row, index) => {
      const id = tips[index];
      if (!id) incompletePublicationScan();
      if (row === `${id} missing`) return;
      const object = objectHeader(row);
      if (object.id !== id) incompletePublicationScan();
      if (object.type === "commit") known.push(id);
    });
  }
  const objects = new Set<string>();
  // Check all current tracked paths/content too, even when a blob is already on the remote.
  for (const entry of nul(await read(["ls-tree", "-r", "-z", input.head]))) {
    const parsed = /^\d+ (blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
    if (!parsed?.[2] || !parsed[3]) incompletePublicationScan();
    if (sensitivePublicationPath(parsed[3])) throw new GitError("sensitive_publication", "Sensitive tracked path");
    if (parsed[1] === "blob") objects.add(hash(parsed[2]));
  }
  const revisions = input.head + "\n" + known.map((id) => `^${id}\n`).join("");
  const reachable = (await read(["rev-list", "--objects", "--no-object-names", "--stdin"], revisions)).toString("ascii").trim();
  if (reachable) for (const id of reachable.split("\n")) objects.add(hash(id));
  if (objects.size > 100000) incompletePublicationScan();
  const ids = [...objects];
  if (!ids.length) return;
  const headers = (await read(["cat-file", "--batch-check"], ids.join("\n") + "\n")).toString("ascii").trim().split("\n");
  if (headers.length !== ids.length) incompletePublicationScan();
  let total = 0;
  const batch: ScanObject[] = [];
  let batchBytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    const bytes = await read(["cat-file", "--batch"], batch.map((item) => item.id).join("\n") + "\n", batchBytes + batch.length * 128);
    try { inspectPublicationBatch(bytes, batch); }
    finally { bytes.fill(0); }
    batch.length = 0; batchBytes = 0;
  };
  for (const [index, header] of headers.entries()) {
    const object = objectHeader(header);
    if (object.id !== ids[index] || object.size > objectLimit) incompletePublicationScan();
    total += object.size;
    if (total > contentLimit) incompletePublicationScan();
    if (batch.length >= 256 || batchBytes + object.size > 16 * 1024 * 1024) await flush();
    batch.push(object); batchBytes += object.size + 1;
  }
  await flush();
}
