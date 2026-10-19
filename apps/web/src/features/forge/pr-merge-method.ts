import { useState } from "react";
import * as z from "zod/mini";
import { readJson, writeJson, type MergeMethod } from "@ace/ui-core";
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
