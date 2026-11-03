import { useState } from "react";
import * as z from "zod/mini";
import { mergeMethods, readJson, writeJson, type MergeMethod } from "@ace/ui-core";
import { useLayout } from "@/lib/layout.tsx";

const Method = z.enum(["squash", "merge", "rebase"]);
const lastKey = "ace.pr.merge-method";

/**
 * The merge method this project merges with: the one last picked in it, else the last picked
 * anywhere, else squash. Kept on this device.
 */
export function useMergeMethod(workspaceId: string) {
  const { storage } = useLayout();
  const projectKey = `${lastKey}:${workspaceId}`;
  const [method, setMethod] = useState<MergeMethod>(() =>
    readJson(storage, projectKey, Method, readJson(storage, lastKey, Method, "squash")),
  );
  return [
    method,
    (next: MergeMethod) => {
      setMethod(next);
      writeJson(storage, projectKey, next);
      writeJson(storage, lastKey, next);
    },
  ] as const;
}

/**
 * The method a merge uses: the one chosen while the repository allows it, else squash, else
 * the first it allows. With the repository's rules unknown, the choice stands.
 */
export function allowedMergeMethod(
  chosen: MergeMethod,
  allowed: readonly MergeMethod[] | undefined,
): MergeMethod {
  if (!allowed?.length || allowed.includes(chosen)) return chosen;
  return allowed.includes("squash") ? "squash" : (allowed[0] ?? chosen);
}

/** The merge methods to offer: the repository's, in the usual order; all three when unknown. */
export function mergeMethodChoices(allowed: readonly MergeMethod[] | undefined) {
  return allowed?.length
    ? mergeMethods.filter((choice) => allowed.includes(choice.method))
    : mergeMethods;
}
