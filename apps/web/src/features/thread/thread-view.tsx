import { useThreadError, useThreadMeta } from "@ace/client-react";
import { RobotIcon } from "@phosphor-icons/react";
import { useLayout } from "@/lib/layout.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { threadPanels } from "@/features/panels/thread-panels.tsx";
import { Screen } from "@/features/shell/screen.tsx";
import { Transcript } from "./transcript.tsx";

/**
 * A thread: transcript in the main column, Changes · Preview · Agents on the right and
 * Terminal · Logs below. TODO(thread slice): Run, Open and Commit actions; composer.
 */
export function ThreadView(props: { threadId: string }) {
  const thread = useThreadMeta(props.threadId);
  const error = useThreadError(props.threadId);
  const { toggleTab } = useLayout();
  const id = props.threadId;
  return (
    <Screen
      title={thread?.title ?? "Loading thread…"}
      subtitle={thread?.workspaceId}
      menu={
        <MenuItem
          icon={<RobotIcon aria-hidden size={16} />}
          keys="mod+j"
          onClick={() => toggleTab("right", "agents")}
        >
          Agents
        </MenuItem>
      }
      {...threadPanels(id)}
    >
      {error ? (
        <p role="alert" className="p-4 text-ui text-status-failed">
          This thread could not be loaded ({error.message}).
        </p>
      ) : (
        <Transcript threadId={id} />
      )}
    </Screen>
  );
}
