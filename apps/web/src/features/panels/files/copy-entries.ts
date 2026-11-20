import type { ClientApi } from "@ace/client";
import { ThreadId } from "@ace/protocol";
import { pathParts } from "@ace/ui-core";
import type { CheckoutSource } from "./checkout-source.ts";
import type { fileManagement } from "./file-management-source.ts";

/** A folder copied from the tree holds at most this many entries; past it, nothing is copied. */
const copyLimit = 2000;
const page = 500;

/**
 * Where a copy of `name` goes in `folder`: the name itself when it's free, else "name copy",
 * then "name copy 2" and on, before the extension of a file ("notes copy.md").
 */
export async function freeName(
  folder: string,
  name: string,
  isFolder: boolean,
  taken: (path: string) => Promise<boolean>,
): Promise<string> {
  const at = (candidate: string) => (folder ? `${folder}/${candidate}` : candidate);
  if (!(await taken(at(name)))) return at(name);
  const dot = isFolder ? -1 : name.lastIndexOf(".");
  const [base, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let count = 1; count < 1000; count++) {
    const candidate = at(`${base} copy${count === 1 ? "" : ` ${count}`}${extension}`);
    if (!(await taken(candidate))) return candidate;
  }
  throw new Error(`Couldn't find a free name for ${name}.`);
}

interface CopyTools {
  client: ClientApi;
  source: CheckoutSource;
  manager: ReturnType<typeof fileManagement>;
  threadId: string;
}

async function readBytes(tools: CopyTools, path: string): Promise<Blob> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for await (const chunk of tools.client.downloadFile({
    threadId: ThreadId.parse(tools.threadId),
    op: "download",
    path,
    offset: 0,
  }))
    chunks.push(new Uint8Array(chunk));
  return new Blob(chunks);
}

async function copyFile(tools: CopyTools, path: string, destination: string) {
  const blob = await readBytes(tools, path);
  const file = new File([blob], pathParts(destination).name);
  await tools.source.upload(tools.threadId, destination, file, null, () => {});
}

/** Every entry under `folder`, folders before what they hold; refuses a folder over the limit. */
async function entriesUnder(tools: CopyTools, folder: string) {
  const found: { path: string; folder: boolean }[] = [];
  const pending = [folder];
  while (pending.length) {
    const next = pending.shift() ?? "";
    let cursor: string | undefined;
    do {
      const listed = await tools.manager.listFolder(next, cursor, page);
      for (const entry of listed.entries) {
        found.push({ path: entry.path, folder: entry.kind === "directory" });
        if (entry.kind === "directory") pending.push(entry.path);
      }
      if (found.length > copyLimit)
        throw new Error(`${folder} holds over ${copyLimit} entries. Copy it on the machine.`);
      cursor = listed.nextCursor ?? undefined;
    } while (cursor);
  }
  return found;
}

/** The version `path` has now, for a change that must name it. */
async function versionOf(tools: CopyTools, path: string) {
  const version = (await tools.source.stat(tools.threadId, path)).version;
  if (version === null) throw new Error(`${path} is gone. Try again.`);
  return version;
}

/**
 * Copy a file, or a folder and everything in it, to a free `destination`. A folder is built
 * under a hidden name beside it and renamed into place once whole, so a copy that fails
 * partway leaves no partial folder at `destination` (its staging goes to Recently deleted) and
 * a retry makes one copy, not a second.
 */
export async function copyEntry(
  tools: CopyTools,
  path: string,
  destination: string,
  folder: boolean,
): Promise<void> {
  if (!folder) return copyFile(tools, path, destination);
  if (destination.startsWith(`${path}/`)) throw new Error("A folder can't be copied into itself.");
  const inside = await entriesUnder(tools, path);
  const { folder: parent, name } = pathParts(destination);
  const taken = async (candidate: string) =>
    (await tools.source.stat(tools.threadId, candidate)).version !== null;
  const staging = await freeName(parent, `.${name}.copying`, true, taken);
  await tools.manager.mutate({ op: "mkdir", path: staging, expected: null });
  try {
    for (const entry of inside) {
      const target = `${staging}${entry.path.slice(path.length)}`;
      if (entry.folder) await tools.manager.mutate({ op: "mkdir", path: target, expected: null });
      else await copyFile(tools, entry.path, target);
    }
    await tools.manager.mutate({
      op: "rename",
      path: staging,
      expected: await versionOf(tools, staging),
      destination,
      destinationExpected: null,
    });
  } catch (failure) {
    await versionOf(tools, staging)
      .then((expected) => tools.manager.mutate({ op: "delete", path: staging, expected }))
      .catch(() => undefined);
    throw failure;
  }
}
