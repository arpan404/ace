import type { GitCli } from "./cli.ts";
import { hash, nul } from "./decode.ts";
import { GitError } from "./types.ts";
import {
  incompletePublicationScan,
  inspectPublicationBatch,
  objectHeader,
  sensitivePublicationPath,
  type ScanObject,
} from "./publication-sensitive.ts";

const metadataLimit = 8 * 1024 * 1024;
const contentLimit = 128 * 1024 * 1024;
const objectLimit = 8 * 1024 * 1024;
/** Scan the complete pinned history. Mutable remote refs cannot establish a security exclusion. */
export async function scanPublication(
  cli: GitCli,
  input: {
    worktree: string;
    directoryFd: number;
    signal: AbortSignal;
    head: string;
    guard?: () => void;
  },
): Promise<void> {
  const read = async (args: string[], stdin?: string, capacity = metadataLimit) => {
    input.guard?.();
    input.signal.throwIfAborted();
    const result = await cli.call(input.worktree, args, {
      directoryFd: input.directoryFd,
      signal: input.signal,
      captureBytes: capacity,
      beforeSpawn: input.guard,
      ...(stdin === undefined ? {} : { input: stdin }),
      env: {
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_NO_LAZY_FETCH: "1",
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
        GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
      },
    });
    input.guard?.();
    if (result.truncated) incompletePublicationScan();
    return result.stdout;
  };
  if ((await read(["rev-parse", "--is-shallow-repository"])).toString("ascii").trim() !== "false")
    incompletePublicationScan();
  const objects = new Set<string>();
  const yamlObjects = new Set<string>();
  const yamlIds: string[] = [];
  // Check all current tracked paths/content too, even when a blob is already on the remote.
  for (const entry of nul(await read(["ls-tree", "-r", "-z", input.head]))) {
    const parsed = /^\d+ (blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
    if (!parsed?.[2] || !parsed[3]) incompletePublicationScan();
    if (sensitivePublicationPath(parsed[3]))
      throw new GitError("sensitive_publication", "Sensitive tracked path");
    if (parsed[1] === "blob") {
      const id = hash(parsed[2]);
      objects.add(id);
      if (/\.ya?ml$/i.test(parsed[3]) && !yamlObjects.has(id)) {
        yamlObjects.add(id);
        yamlIds.push(id);
      }
    }
  }
  const reachable = (await read(["rev-list", "--objects", "--no-object-names", input.head]))
    .toString("ascii")
    .trim();
  if (reachable) for (const id of reachable.split("\n")) objects.add(hash(id));
  if (objects.size > 100000) incompletePublicationScan();
  const ids = [...objects];
  let total = 0;
  const batch: ScanObject[] = [];
  let batchBytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    const bytes = await read(
      ["cat-file", "--batch"],
      batch.map((item) => item.id).join("\n") + "\n",
      batchBytes + batch.length * 128,
    );
    try {
      // Traverse raw commit and tree edges as well as Git's initial object enumeration.
      for (const { id, format } of inspectPublicationBatch(bytes, batch)) {
        if (format === "yaml" && !yamlObjects.has(id)) {
          yamlObjects.add(id);
          yamlIds.push(id);
        }
        if (objects.has(id)) continue;
        objects.add(id);
        ids.push(id);
        if (objects.size > 100000) incompletePublicationScan();
      }
    } finally {
      bytes.fill(0);
    }
    batch.length = 0;
    batchBytes = 0;
  };
  // Historical trees can label a blob after its first read. A second bounded pass
  // inspects every YAML spelling, including reused/renamed blobs. Both passes share the byte budget.
  for (const phase of [
    { ids, format: undefined },
    { ids: yamlIds, format: "yaml" },
  ] as const) {
    let position = 0;
    while (position < phase.ids.length) {
      const group = phase.ids.slice(position, position + 512);
      position += group.length;
      const headers = (await read(["cat-file", "--batch-check"], group.join("\n") + "\n"))
        .toString("ascii")
        .trim()
        .split("\n");
      if (headers.length !== group.length) incompletePublicationScan();
      for (const [index, header] of headers.entries()) {
        const object = objectHeader(header);
        if (phase.format === "yaml" && object.type !== "blob") incompletePublicationScan();
        if (object.id !== group[index] || object.size > objectLimit) incompletePublicationScan();
        total += object.size;
        if (total > contentLimit) incompletePublicationScan();
        if (batch.length >= 256 || batchBytes + object.size > 16 * 1024 * 1024) await flush();
        batch.push({ ...object, ...(phase.format ? { format: phase.format } : {}) });
        batchBytes += object.size + 1;
      }
      await flush();
    }
  }
}
