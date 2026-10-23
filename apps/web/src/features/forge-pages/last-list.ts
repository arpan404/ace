import { readJson, writeJson } from "@ace/ui-core";
import { useEffect } from "react";
import { z } from "zod";
import { useLayout } from "@/lib/layout.tsx";

export type ForgeList = "inbox" | "pulls" | "issues";

const key = "ace.forge.list";
const lists = z.enum(["inbox", "pulls", "issues"]);
const paths = { inbox: "/inbox", pulls: "/pulls", issues: "/issues" } as const;

/** Where the GitHub button goes: the list last looked at on this device, Pull requests at first. */
export function useLastListPath(): (typeof paths)[ForgeList] {
  const { storage } = useLayout();
  return paths[readJson(storage, key, lists, "pulls")];
}

/** Remembers the list on screen, so the GitHub button comes back to it. */
export function useRememberList(list: ForgeList) {
  const { storage } = useLayout();
  useEffect(() => writeJson(storage, key, list), [storage, list]);
}
