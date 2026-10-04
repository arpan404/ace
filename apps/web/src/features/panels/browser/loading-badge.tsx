import { useCallback } from "react";
import { Spinner } from "@/components/ui/spinner.tsx";
import type { WorkspaceTab } from "@/lib/workspace/index.ts";
import { useLocal } from "../store.ts";
import { loadingKey, loadingTabs } from "./loading.ts";

/** A browser tab's strip mark while its page loads; the title and close button keep their place. */
export function LoadingBadge(props: { scope: string; tab: WorkspaceTab }) {
  const key = loadingKey(props.scope, props.tab.key);
  const loading = useLocal(
    loadingTabs,
    useCallback((tabs: ReadonlySet<string>) => tabs.has(key), [key]),
  );
  return loading ? <Spinner label="Loading" className="ml-0.5" /> : null;
}
