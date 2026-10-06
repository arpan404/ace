import type { Dock } from "@/lib/workspace/index.ts";
import { usePanelServices } from "../services.ts";
import { WithServices } from "../with-services.tsx";
import { SessionsMenu } from "./sessions-menu.tsx";
import { useBackgroundShells, useThreadTerminals } from "./use-terminals.ts";

/**
 * The bottom panel's terminal sessions, whatever tab shows: with Logs or a new tab showing, a
 * shell an agent left running still reads as "not shown" here. Drawn once the thread has any
 * shell of its own or an agent's.
 */
export default function DockSessions(props: { scope: string; dock: Dock }) {
  return (
    <WithServices quiet>
      <Sessions {...props} />
    </WithServices>
  );
}

function Sessions(props: { scope: string; dock: Dock }) {
  const { terminals } = usePanelServices();
  const { list } = useThreadTerminals(terminals, props.scope);
  const shells = useBackgroundShells(props.scope);
  if (!list.length && !shells.length) return null;
  return <SessionsMenu scope={props.scope} dock={props.dock} />;
}
