import { useCallback, type ReactNode } from "react";
import { openExternal } from "@/boot/open-external.ts";
import { WebLinkOpener } from "@/components/web-link.tsx";
import {
  useWorkspaceActions,
  useWorkspaceStore,
  type WorkspaceDefinition,
} from "@/lib/workspace/index.ts";

/**
 * Web links followed anywhere on a workspace's screen (its main column, its panels, their
 * menus) open in the workspace's own browser: the kind that opens addresses (`fromUrl`), shown
 * in the side panel. A workspace without one hands the address to the system's browser.
 */
export function WorkspaceWebLinks(props: {
  scope: string;
  definition: WorkspaceDefinition;
  children: ReactNode;
}) {
  const { scope, definition } = props;
  const store = useWorkspaceStore();
  const actions = useWorkspaceActions(scope);
  const open = useCallback(
    (url: string) => {
      const external = () => void openExternal(url).catch(() => {});
      void definition.load().then((kinds) => {
        const request = kinds.find((kind) => kind.fromUrl)?.fromUrl?.(url, store.get(scope));
        if (request) actions.open(request);
        else external();
      }, external);
    },
    [definition, store, scope, actions],
  );
  return <WebLinkOpener value={open}>{props.children}</WebLinkOpener>;
}
