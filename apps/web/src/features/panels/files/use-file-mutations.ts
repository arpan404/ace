import { useClient } from "@ace/client-react";
import { cleanPath, pathParts } from "@ace/ui-core";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui/toast.tsx";
import { checkoutError } from "./checkout-source.ts";
import { checkoutChanged } from "./checkout-refresh.ts";
import { copyEntry, freeName } from "./copy-entries.ts";
import { fileManagement, type FileMutation } from "./file-management-source.ts";
import { useCheckoutSource } from "./use-checkout.ts";

const plural = (count: number) => (count === 1 ? "1 item" : `${count} items`);
const failureText = (failure: unknown) =>
  failure instanceof Error ? failure.message : "Couldn't change the file. Try again.";

/**
 * Changing checkout files through the daemon's file operations, shared by the operation dialogs
 * and the tree's direct actions (drag, paste, duplicate, bulk delete): each change refreshes the
 * folders it touched, and a delete goes to Recently deleted with an Undo toast.
 */
export function useFileMutations(threadId: string, onChanged?: (path: string) => void) {
  const client = useClient();
  const queries = useQueryClient();
  const source = useCheckoutSource();
  const toast = useToast();
  const manager = fileManagement(client, threadId);
  const refresh = (paths: readonly (string | undefined)[]) => {
    checkoutChanged(threadId, paths);
    void queries.invalidateQueries({ queryKey: ["checkout"] });
  };
  /** The version a change must name, or why it can't go ahead. */
  const versionOf = async (path: string) => {
    const expected = (await source.stat(threadId, path)).version;
    if (expected === null) throw new Error("This path is gone. Refresh and try again.");
    return expected;
  };
  const run = async (mutation: FileMutation) => {
    const result = await manager.mutate(mutation);
    refresh([result.path, result.destination]);
    return result;
  };
  /** Offer Undo for what just went to Recently deleted. */
  const offerUndo = (deleted: readonly { path: string; trashId: string }[]) => {
    if (!deleted.length) return;
    const only = deleted.length === 1 ? deleted[0] : undefined;
    toast.add({
      title: only ? `Deleted ${only.path}` : `Deleted ${plural(deleted.length)}`,
      actionProps: {
        children: "Undo",
        onClick: () => {
          void (async () => {
            for (const { path, trashId } of deleted) {
              await manager.mutate({ op: "restore", trashId, path, expected: null });
              refresh([path]);
              onChanged?.(path);
            }
          })().catch((failure: unknown) =>
            toast.error({
              title: "Couldn't restore the file",
              description: checkoutError(failure).message,
            }),
          );
        },
      },
    });
  };
  /** Move each path to Recently deleted, then offer one Undo for all of them. */
  const remove = async (paths: readonly string[]) => {
    const deleted: { path: string; trashId: string }[] = [];
    try {
      for (const raw of paths) {
        const path = cleanPath(raw);
        const result = await run({ op: "delete", path, expected: await versionOf(path) });
        onChanged?.(result.path);
        if (result.trashId) deleted.push({ path, trashId: result.trashId });
      }
    } finally {
      offerUndo(deleted);
    }
  };
  /** Move each path into `folder` ("" is the root), keeping its name; a taken name stops it. */
  const move = async (paths: readonly string[], folder: string) => {
    const into = cleanPath(folder);
    try {
      for (const raw of paths) {
        const path = cleanPath(raw);
        const { name, folder: from } = pathParts(path);
        if (from === into || into === path || into.startsWith(`${path}/`)) continue;
        const destination = into ? `${into}/${name}` : name;
        if ((await source.stat(threadId, destination)).version !== null)
          throw new Error(`${destination} already exists. Rename one of them first.`);
        const result = await run({
          op: "move",
          path,
          expected: await versionOf(path),
          destination,
          destinationExpected: null,
        });
        if (result.destination) onChanged?.(result.destination);
      }
    } catch (failure) {
      toast.error({ title: "Couldn't move the files", description: failureText(failure) });
    }
  };
  /**
   * Copy each path into `folder`: a name already there gets " copy" (then " copy 2"…) before
   * its extension, as a duplicate does. Resolves the new paths.
   */
  const copy = async (paths: readonly { path: string; folder: boolean }[], folder: string) => {
    const into = cleanPath(folder);
    const made: string[] = [];
    try {
      for (const entry of paths) {
        const path = cleanPath(entry.path);
        const taken = async (candidate: string) =>
          (await source.stat(threadId, candidate)).version !== null;
        const destination = await freeName(into, pathParts(path).name, entry.folder, taken);
        await copyEntry({ client, source, manager, threadId }, path, destination, entry.folder);
        refresh([destination]);
        made.push(destination);
      }
    } catch (failure) {
      toast.error({ title: "Couldn't copy the files", description: failureText(failure) });
    }
    return made;
  };
  return { manager, refresh, versionOf, run, offerUndo, remove, move, copy };
}
