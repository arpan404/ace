import { describeDaemonError, daemonErrorCode } from "@/lib/daemon-command.ts";
import {
  ArrowClockwiseIcon,
  ClipboardTextIcon,
  CopyIcon,
  MagnifyingGlassIcon,
  SelectionAllIcon,
  TerminalWindowIcon,
  TrashIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { MenuItem, MenuSeparator } from "@/components/ui/menu.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import {
  shownTab,
  useScopeWorkspace,
  useWorkspaceActions,
  useWorkspaceStore,
  type TabViewProps,
} from "@/lib/workspace/index.ts";
import { usePanelServices } from "../services.ts";
import type { TerminalInfo } from "../sources.ts";
import { WithServices } from "../with-services.tsx";
import { FindBar } from "./find-bar.tsx";
import { RenameDialog } from "./rename-dialog.tsx";
import type { TerminalSessions } from "./sessions.ts";
import type { TerminalSurface } from "./surface.ts";
import {
  isPendingTerminal,
  newTerminal,
  openTerminalIds,
  reusesSpareShell,
  spareShell,
  terminalTab,
} from "./tabs.ts";
import { setTabUi, useTabUi } from "./tab-ui.ts";
import { TerminalView } from "./terminal-view.tsx";
import { useExitCode, useThreadTerminals } from "./use-terminals.ts";

/*
 * One terminal tab: a PTY of yours in the thread's checkout. A tab without a shell yet starts
 * one when it first shows (picking up a running shell no tab shows, for the plain `terminal`
 * tab). Hiding the panel keeps the shell; closing the tab ends it (thread-kinds' onClose).
 */

const failure = (error: unknown) =>
  error instanceof Error && error.name === "ClientError"
    ? describeDaemonError(daemonErrorCode(error))
    : "ace couldn't start a shell. Try opening a new terminal.";

export default function TerminalTabView(props: TabViewProps) {
  return (
    <WithServices>
      {isPendingTerminal(props.tab.id) ? (
        <StartingTerminal {...props} />
      ) : (
        <PtyTerminal {...props} />
      )}
    </WithServices>
  );
}

/** A tab whose shell is about to start: picks up a spare one or opens one, then becomes it. */
function StartingTerminal(props: TabViewProps) {
  const { scope, tab } = props;
  const { terminals } = usePanelServices();
  const store = useWorkspaceStore();
  const actions = useWorkspaceActions(scope);
  const { link } = useThreadTerminals(terminals, scope);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (link !== "connected") return;
    let live = true;
    const start = async (): Promise<TerminalInfo> => {
      if (reusesSpareShell(tab.id)) {
        await terminals.source.refresh(scope);
        const spare = spareShell(terminals.source.list(scope), openTerminalIds(store.get(scope)));
        if (spare) return spare;
      }
      // Keyed by tab and attempt: a remount shares the shell, Try again asks for a new one.
      return terminals.openFor(`${tab.key}#${attempt}`, scope);
    };
    start().then(
      (terminal) => {
        if (!live) return;
        terminals.requestFocus(terminal.id);
        // A tab restarted in place keeps the name it had.
        actions.replace(tab.key, {
          ...terminalTab(terminal),
          title: tab.title ?? terminal.name,
          pinned: tab.pinned,
        });
      },
      (reason: unknown) => {
        if (live) setError(failure(reason));
      },
    );
    return () => {
      live = false;
    };
  }, [link, attempt, terminals, store, actions, scope, tab.id, tab.key, tab.pinned, tab.title]);
  if (error)
    return (
      <EmptyState
        icon={WarningCircleIcon}
        title="Couldn't start a terminal"
        description={error}
        action={
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                setError(undefined);
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </Button>
            <Button size="sm" variant="outline" onClick={() => actions.close(tab.key)}>
              Close tab
            </Button>
          </div>
        }
      />
    );
  return (
    <div role="status" className="grid h-full place-items-center">
      <span className="flex items-center gap-2 text-ui text-muted-foreground">
        <Spinner />
        {link === "connected"
          ? "Starting a shell in this thread's checkout…"
          : "Waiting for ace to start a shell…"}
      </span>
    </div>
  );
}

/** One of your PTYs: output, input, Find, the clipboard menu, and its exit or loss. */
function PtyTerminal(props: TabViewProps) {
  const { scope, tab } = props;
  const { terminals, terminalUi } = usePanelServices();
  const store = useWorkspaceStore();
  const actions = useWorkspaceActions(scope);
  const { list, listed, link } = useThreadTerminals(terminals, scope);
  const [readError, setReadError] = useState(false);
  /** The terminal id the list was last read for, so a missing one is read once, not forever. */
  const [checked, setChecked] = useState<string>();
  const info = list.find((terminal) => terminal.id === tab.id);
  // A tab restored from storage, or a shell started elsewhere (Run), names a PTY this client
  // hasn't listed yet: read the list before saying it has ended.
  const missing = !listed || (!info && checked !== tab.id);
  useEffect(() => {
    if (!missing || link !== "connected") return;
    let live = true;
    const id = tab.id;
    terminals.source.refresh(scope).then(
      () => {
        if (!live) return;
        setReadError(false);
        setChecked(id);
      },
      () => live && setReadError(true),
    );
    return () => {
      live = false;
    };
  }, [missing, link, terminals, scope, tab.id]);
  // The tab shows the daemon's name until someone renames it.
  const name = info?.name;
  useEffect(() => {
    if (name && tab.title === undefined) actions.update(tab.key, { title: name });
  }, [name, tab.title, tab.key, actions]);
  if (!info && (missing || !listed))
    return readError ? (
      <EmptyState
        icon={WarningCircleIcon}
        title="Couldn't read this thread's terminals"
        description="ace didn't answer. Check that it's running, then try again."
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setReadError(false);
              terminals.source.refresh(scope).then(
                () => setChecked(tab.id),
                () => setReadError(true),
              );
            }}
          >
            Try again
          </Button>
        }
      />
    ) : (
      <div role="status" className="grid h-full place-items-center">
        <span className="flex items-center gap-2 text-ui text-muted-foreground">
          <Spinner />
          {link === "connected" ? "Connecting to the terminal…" : "Waiting for ace…"}
        </span>
      </div>
    );
  if (!info)
    return (
      <EmptyState
        icon={TerminalWindowIcon}
        title="This terminal has ended"
        description="ace no longer runs this shell; it may have restarted. Its output is gone."
        action={
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() =>
                actions.replace(tab.key, { ...newTerminal(store.get(scope)), pinned: tab.pinned })
              }
            >
              Start a new terminal
            </Button>
            <Button size="sm" variant="outline" onClick={() => actions.close(tab.key)}>
              Close tab
            </Button>
          </div>
        }
      />
    );
  return (
    <LiveTerminal
      {...props}
      terminals={terminals}
      terminalUi={terminalUi}
      info={info}
      offline={link !== "connected"}
    />
  );
}

function LiveTerminal(
  props: TabViewProps & {
    terminals: TerminalSessions;
    terminalUi: ReturnType<typeof usePanelServices>["terminalUi"];
    info: TerminalInfo;
    offline: boolean;
  },
) {
  const { scope, tab, terminals, terminalUi, info } = props;
  const store = useWorkspaceStore();
  const actions = useWorkspaceActions(scope);
  const toast = useToast();
  const surface = useRef<TerminalSurface | null>(null);
  const ui = useTabUi(terminalUi, tab.key);
  const exitCode = useExitCode(terminals, info.id);
  const exited = exitCode !== null || info.exited;
  const [focusRequested] = useState(() => terminals.takeFocusRequest(info.id));
  // Startup may finish while the panel is hiding or the person has switched tabs.
  const panel = useScopeWorkspace(scope);
  const autoFocus = focusRequested && panel.open && shownTab(panel)?.key === tab.key;
  const title = tab.title ?? info.name;
  const openFind = () => setTabUi(terminalUi, tab.key, { find: true });
  const closeFind = () => {
    setTabUi(terminalUi, tab.key, { find: false });
    surface.current?.focus();
  };
  const paste = () => {
    navigator.clipboard?.readText().then(
      (text) => {
        surface.current?.paste(text);
        surface.current?.focus();
      },
      () =>
        toast.error({
          title: "Couldn't read the clipboard",
          description: "Allow clipboard access, or paste with the keyboard.",
        }),
    );
  };
  const copy = () => {
    const text = surface.current?.selection();
    if (text) void navigator.clipboard?.writeText(text);
  };
  const restart = () => {
    actions.replace(tab.key, { ...newTerminal(store.get(scope)), title, pinned: tab.pinned });
    void terminals.close(info.id, scope).catch(() => {});
  };
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {props.offline && (
        <p
          role="status"
          className="flex h-8 shrink-0 items-center gap-2 px-3 text-xs text-muted-foreground shadow-[inset_0_-1px_0_var(--border)]"
        >
          <Spinner /> Reconnecting. Output printed meanwhile replays when ace is back.
        </p>
      )}
      <ContextMenu>
        <ContextMenuTrigger
          render={<div className="relative flex min-h-0 flex-1 flex-col pt-2 pl-3" />}
        >
          <TerminalView
            sessions={terminals}
            id={info.id}
            name={title}
            onSurface={(next) => {
              surface.current = next;
            }}
            readOnly={exited}
            autoFocus={autoFocus}
            onFind={openFind}
          />
          {ui.find && <FindBar surface={surface} onClose={closeFind} />}
        </ContextMenuTrigger>
        <ContextMenuContent>
          <MenuItem icon={<CopyIcon aria-hidden size={16} />} keys="mod+c" onClick={copy}>
            Copy
          </MenuItem>
          <MenuItem
            icon={<ClipboardTextIcon aria-hidden size={16} />}
            keys="mod+v"
            disabled={exited}
            onClick={paste}
          >
            Paste
          </MenuItem>
          <MenuItem
            icon={<SelectionAllIcon aria-hidden size={16} />}
            onClick={() => surface.current?.selectAll()}
          >
            Select all
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={<MagnifyingGlassIcon aria-hidden size={16} />}
            shortcut="findInTerminal"
            onClick={openFind}
          >
            Find
          </MenuItem>
          <MenuItem
            icon={<TrashIcon aria-hidden size={16} />}
            onClick={() => terminals.clear(info.id)}
          >
            Clear
          </MenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {exited && (
        <div className="flex h-9 shrink-0 items-center gap-2 px-3 text-xs text-muted-foreground shadow-[inset_0_1px_0_var(--border)]">
          <span className="min-w-0 flex-1 truncate">
            {exitCode === null ? "The shell exited." : `The shell exited with code ${exitCode}.`}
          </span>
          <Button size="sm" variant="ghost" onClick={restart}>
            <ArrowClockwiseIcon aria-hidden size={14} />
            Restart
          </Button>
          <Button size="sm" variant="ghost" onClick={() => actions.close(tab.key)}>
            Close
          </Button>
        </div>
      )}
      <RenameDialog
        open={ui.rename}
        title="Rename terminal"
        current={title}
        fallback={info.name}
        onOpenChange={(open) => setTabUi(terminalUi, tab.key, { rename: open })}
        onRename={(next) => actions.update(tab.key, { title: next })}
      />
    </div>
  );
}

export { TerminalActions } from "./terminal-actions.tsx";
