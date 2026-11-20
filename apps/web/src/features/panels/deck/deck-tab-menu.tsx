import { useThreadField } from "@ace/client-react/thread-field";
import { MenuItem, MenuSeparator } from "@/components/ui/menu.tsx";
import { useOpenInApps } from "@/lib/open-in-apps.ts";
import { threadCheckoutRoot } from "@/lib/thread-fields.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { revealInExplorer } from "../files/file-tree-deck.ts";
import { OpenWithMenu } from "../files/open-with-menu.tsx";

/**
 * The Deck's own items at the end of a tab's menu (spec 24, 40): the file's place in the
 * checkout, its uncommitted diff, the absolute path, and the open-in catalogue.
 */
export function DeckTabMenuItems(props: {
  threadId: string;
  path: string;
  onReveal(path: string): void;
}) {
  const { threadId, path } = props;
  const actions = useWorkspaceActions(threadId);
  const apps = useOpenInApps(threadId);
  const root = useThreadField(threadId, threadCheckoutRoot);
  return (
    <>
      {root && (
        <MenuItem onClick={() => void navigator.clipboard?.writeText(`${root}/${path}`)}>
          Copy path
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem
        onClick={() => {
          props.onReveal(path);
          revealInExplorer(threadId, path);
        }}
      >
        Reveal in Files
      </MenuItem>
      <MenuItem
        onClick={() => actions.open({ kind: "changes", data: { scope: "working-tree", path } })}
      >
        Show uncommitted changes
      </MenuItem>
      <OpenWithMenu apps={apps} path={path} kind="file" label="Open in" />
    </>
  );
}
