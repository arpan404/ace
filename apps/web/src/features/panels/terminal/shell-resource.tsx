import type { BackgroundTask } from "@ace/protocol";
import { useClient, useIntentSender, useItem, useTask } from "@ace/client-react";
import {
  CopyIcon,
  HandGrabbingIcon,
  LockSimpleIcon,
  MagnifyingGlassIcon,
  StopIcon,
  TerminalIcon,
} from "@phosphor-icons/react";
import { formatElapsed } from "@ace/ui-core";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { readOutputText } from "@/lib/output-read.ts";
import { keymap } from "@/lib/keymap.ts";
import { useSeconds } from "@/lib/time.ts";
import { useWorkspaceActions, type TabViewProps } from "@/lib/workspace/index.ts";
import { usePanelServices } from "../services.ts";
import { WithServices } from "../with-services.tsx";
import { FindBar } from "./find-bar.tsx";
import { TerminalScreen } from "./screen.ts";
import { SessionsMenu } from "./sessions-menu.tsx";
import type { TerminalSurface } from "./surface.ts";
import { shellLabel } from "./tabs.ts";
import { setTabUi, useTabUi } from "./tab-ui.ts";
import { ScreenRows, useScreenSurface, type ScreenMark } from "./terminal-view.tsx";
import { NewTerminalButton } from "./new-terminal-button.tsx";
import { ToolbarButton } from "./toolbar.tsx";

/*
 * An agent's background shell as a tab: read-only, because the agent owns it. Its output is
 * what the agent's tool call reports (the latest 4 KiB live), and the whole of it from the
 * daemon's stream store on request. Stop asks the agent's provider to end it, where the
 * provider allows; closing the tab only stops showing it.
 */

const state = {
  running: "Running",
  completed: "Finished",
  failed: "Failed",
  stopped: "Stopped",
  unknown: "May still be running",
};

/** Why Take over is unavailable: background shells aren't PTYs ace can attach a keyboard to. */
export const takeOverReason =
  "An agent's background shell isn't a terminal ace can type into yet. Stop it and run the command in a terminal of your own instead.";

export default function ShellTabView(props: TabViewProps) {
  return (
    <WithServices>
      <ShellResource {...props} />
    </WithServices>
  );
}

function ShellResource(props: TabViewProps) {
  const { scope, tab } = props;
  const task = useTask(scope, tab.id);
  const actions = useWorkspaceActions(scope);
  if (!task)
    return (
      <EmptyState
        icon={TerminalIcon}
        title="This shell is no longer in the thread"
        description="The agent's background shell was removed, or this thread hasn't loaded it yet."
        action={
          <Button size="sm" variant="outline" onClick={() => actions.close(tab.key)}>
            Close tab
          </Button>
        }
      />
    );
  return <ShellOutput {...props} task={task} />;
}

function ShellOutput(props: TabViewProps & { task: BackgroundTask }) {
  const { scope, tab, task } = props;
  const actions = useWorkspaceActions(scope);
  // Opened by id alone (the transcript, the summary): the tab takes the command's short name.
  const label = shellLabel(task.title);
  useEffect(() => {
    if (tab.title === undefined) actions.update(tab.key, { title: label });
  }, [tab.title, tab.key, label, actions]);
  const client = useClient();
  const { terminalUi } = usePanelServices();
  const ui = useTabUi(terminalUi, tab.key);
  const item = useItem(scope, task.toolCallId ?? "");
  const detail =
    item?.type === "tool_call" && item.call.detail.kind === "shell" ? item.call.detail : undefined;
  const output = detail?.output;
  const command = detail?.command ?? task.title;
  const [full, setFull] = useState<{ bytes: number; text: string }>();
  const [loading, setLoading] = useState<"idle" | "loading" | "failed">("idle");
  // A full read is replaced by the live tail as soon as the shell prints more.
  const shown = full && full.bytes === output?.bytes ? full.text : (output?.tail ?? "");
  const rows = useMemo(() => {
    const screen = new TerminalScreen();
    screen.write(shown.replace(/(?<!\r)\n/g, "\r\n"));
    return screen.rows();
  }, [shown]);
  const [mark, setMark] = useState<ScreenMark>();
  const surface = useRef<TerminalSurface | null>(null);
  useScreenSurface(
    (next) => {
      surface.current = next;
    },
    rows,
    setMark,
  );
  const loadAll = () => {
    if (!output) return;
    const bytes = output.bytes;
    setLoading("loading");
    readOutputText(client, output.streamId).then(
      (text) => {
        setFull({ bytes, text });
        setLoading("idle");
      },
      () => setLoading("failed"),
    );
  };
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <ShellHeader scope={scope} task={task} command={command} />
      {output?.truncated && shown !== full?.text && (
        <p className="flex h-8 shrink-0 items-center gap-2 px-3 text-xs text-subtle-foreground">
          Showing the latest output.
          <Button size="sm" variant="ghost" disabled={loading === "loading"} onClick={loadAll}>
            {loading === "loading" && <Spinner />}
            {loading === "failed" ? "Couldn't load it. Retry" : "Show full output"}
          </Button>
        </p>
      )}
      <ContextMenu>
        <ContextMenuTrigger render={<div className="relative flex min-h-0 flex-1 flex-col" />}>
          {rows.length === 1 && !shown ? (
            <p className="px-3 pt-2 text-ui text-subtle-foreground">
              {task.status === "running" ? "No output yet." : "It printed nothing."}
            </p>
          ) : (
            <ScreenRows rows={rows} label={`${shellLabel(task.title)} output`} mark={mark} />
          )}
          {ui.find && (
            <FindBar
              surface={surface}
              onClose={() => setTabUi(terminalUi, tab.key, { find: false })}
            />
          )}
        </ContextMenuTrigger>
        <ContextMenuContent>
          <MenuItem
            icon={<CopyIcon aria-hidden size={16} />}
            keys="mod+c"
            onClick={() => {
              const text = window.getSelection()?.toString() || shown;
              void navigator.clipboard?.writeText(text);
            }}
          >
            Copy
          </MenuItem>
          <MenuItem
            icon={<MagnifyingGlassIcon aria-hidden size={16} />}
            keys={keymap.findInTerminal.keys}
            onClick={() => setTabUi(terminalUi, tab.key, { find: true })}
          >
            Find
          </MenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}

/** Who owns it, what it runs, how long, and what you can do about it. */
function ShellHeader(props: { scope: string; task: BackgroundTask; command: string }) {
  const { task } = props;
  const running = task.status === "running";
  const now = useSeconds(running);
  const { send, intent, error } = useIntentSender();
  const elapsed = (task.endedAt ?? now) - task.startedAt;
  // A clock disagreement with the daemon shows no age rather than a wrong one.
  const age = elapsed >= 0 && elapsed < 7 * 24 * 3_600_000 ? formatElapsed(elapsed) : undefined;
  const stopping = intent?.state === "pending" || (intent?.state === "acked" && running);
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 px-3 text-xs text-muted-foreground shadow-[inset_0_-1px_0_var(--border)]">
      <Tip label="The agent owns this shell; you can watch and stop it">
        <span className="flex shrink-0 items-center gap-1.5 text-subtle-foreground">
          <LockSimpleIcon aria-hidden size={13} />
          Agent shell
        </span>
      </Tip>
      <code
        title={props.command}
        className="min-w-0 truncate rounded-[5px] bg-secondary px-1.5 py-px font-mono text-[12px] text-foreground"
      >
        {props.command}
      </code>
      <span className="shrink-0">
        {state[task.status]}
        {age && ` · ${age.replace(/ \d+s$/, "")}`}
      </span>
      <span className="flex-1" />
      {(intent?.state === "failed" || !!error) && (
        <span role="alert" className="shrink-0 text-status-failed">
          Couldn't stop it
        </span>
      )}
      {running && (
        <Tip
          label={
            task.stoppable
              ? "Ask the agent's tool to end this shell"
              : "This agent's provider doesn't let ace stop one shell on its own"
          }
        >
          {/* A disabled button still shows why on hover and focus. */}
          <span tabIndex={task.stoppable ? -1 : 0} className="inline-flex">
            <Button
              size="sm"
              variant="ghost"
              disabled={!task.stoppable || stopping}
              onClick={() =>
                void send({ type: "background_task.stop", taskId: task.id }).catch(() => {})
              }
            >
              {stopping ? <Spinner /> : <StopIcon aria-hidden size={14} />}
              {stopping ? "Stopping" : "Stop"}
            </Button>
          </span>
        </Tip>
      )}
      <Tip label={takeOverReason}>
        <span tabIndex={0} className="inline-flex">
          <Button size="sm" variant="ghost" disabled aria-label="Take over (unavailable)">
            <HandGrabbingIcon aria-hidden size={14} />
            Take over
          </Button>
        </span>
      </Tip>
    </div>
  );
}

/** The strip's buttons while an agent shell shows: New terminal, Find and sessions. */
export function ShellActions(props: TabViewProps) {
  return (
    <WithServices quiet>
      <ShellButtons {...props} />
    </WithServices>
  );
}

function ShellButtons(props: TabViewProps) {
  const { scope, tab, dock } = props;
  const { terminalUi } = usePanelServices();
  return (
    <>
      <NewTerminalButton scope={scope} dock={dock} />
      <ToolbarButton
        icon={MagnifyingGlassIcon}
        label="Find"
        shortcut="findInTerminal"
        onClick={() => setTabUi(terminalUi, tab.key, { find: true })}
      />
      <SessionsMenu scope={scope} dock={dock} />
    </>
  );
}
