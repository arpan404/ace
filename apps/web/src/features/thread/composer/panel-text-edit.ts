import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  findTab,
  PanelRoomContext,
  tabKey,
  textEditTab,
  textEditTabKind,
  TextEditsContext,
  useOptionalWorkspace,
} from "@/lib/workspace/index.ts";

/*
 * Editing a pasted text in the thread's side panel: a chip opens a tab of its own, the tab's
 * typing is kept here, and the edit goes in the chip's place (`commit`) once typing pauses, the
 * tab closes or the message is sent. The tab follows its chip through each edited copy and
 * closes when the chip goes (removed or sent) or the composer does (another thread).
 */

/** Typing that pauses this long is kept: the chip's file is replaced by the edited text. */
export const keepEditAfter = 1000;

/** What `commit` made of an edit: the chip that holds it now. */
interface Copy {
  key: number;
  name: string;
}

interface Edit {
  /** The chip being edited; follows each edited copy. */
  key: number;
  /** The tab's own id, stable across copies. */
  id: string;
  /** The tab has been seen open, so its absence means it closed. */
  shown: boolean;
  /** The text the chip holds now, once read. */
  kept: string | undefined;
  typed: string | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export function usePanelTextEdit(args: {
  /** The thread whose panel holds the tabs. */
  scope: string;
  /** The chips there are now. */
  keys: readonly number[];
  /** Put edited text in a chip's place; the chip that holds it, if it could. */
  commit(key: number, text: string): Copy | undefined;
}): {
  /** Open (or show) a chip's text in the panel; false where there is no panel for it. */
  open(key: number, name: string, file: File): boolean;
  /** The chips whose text is open in the panel. */
  editing: ReadonlySet<number>;
  /** Keep every pending edit now; true when one was kept (the chips change on the next render). */
  flush(): boolean;
} {
  const edits = useContext(TextEditsContext);
  const room = useContext(PanelRoomContext);
  const workspace = useOptionalWorkspace(args.scope);
  const open = useRef(new Map<string, Edit>());
  const next = useRef(0);
  const [editing, setEditing] = useState<ReadonlySet<number>>(new Set());
  const latest = useRef(args.commit);
  useLayoutEffect(() => {
    latest.current = args.commit;
  });
  const shown = () => setEditing(new Set([...open.current.values()].map((edit) => edit.key)));
  const keep = (edit: Edit): boolean => {
    clearTimeout(edit.timer);
    edit.timer = undefined;
    const text = edit.typed;
    if (text === undefined || text === edit.kept) return false;
    const copy = latest.current(edit.key, text);
    if (!copy) return false;
    edit.key = copy.key;
    edit.kept = text;
    workspace?.actions.update(tabKey(textEditTabKind, edit.id), { title: copy.name });
    shown();
    return true;
  };
  const end = (edit: Edit) => {
    clearTimeout(edit.timer);
    open.current.delete(edit.id);
    edits?.end(edit.id);
  };
  // A tab the person closed keeps what was typed, then its edit ends.
  useEffect(() => {
    if (!workspace) return;
    return workspace.subscribe(() => {
      const tabs = workspace.read();
      for (const edit of open.current.values()) {
        const present = !!findTab(tabs, tabKey(textEditTabKind, edit.id));
        if (present) edit.shown = true;
        else if (edit.shown) {
          keep(edit);
          end(edit);
          shown();
        }
      }
    });
  });
  // A chip that went (removed, or sent with its message) closes its tab.
  const chips = new Set(args.keys);
  useEffect(() => {
    let gone = false;
    for (const edit of open.current.values()) {
      if (chips.has(edit.key)) continue;
      gone = true;
      end(edit);
      void workspace?.actions.close(tabKey(textEditTabKind, edit.id));
    }
    if (gone) shown();
  });
  // Leaving the thread closes its tabs; the composer that held their text is going.
  useEffect(
    () => () => {
      for (const edit of open.current.values()) {
        clearTimeout(edit.timer);
        open.current.delete(edit.id);
        edits?.end(edit.id);
        void workspace?.actions.close(tabKey(textEditTabKind, edit.id));
      }
    },
    [workspace, edits],
  );
  return {
    editing,
    flush: () => [...open.current.values()].map(keep).some(Boolean),
    open: (key, name, file) => {
      if (!edits || !room || !workspace) return false;
      const existing = [...open.current.values()].find((edit) => edit.key === key);
      if (existing) {
        workspace.actions.open(textEditTab(existing.id, name));
        return true;
      }
      const edit: Edit = {
        key,
        id: `paste-${++next.current}`,
        shown: false,
        kept: undefined,
        typed: undefined,
        timer: undefined,
      };
      void file.text().then((text) => (edit.kept ??= text));
      open.current.set(edit.id, edit);
      edits.start(edit.id, {
        file,
        typed: () => edit.typed,
        type: (text) => {
          edit.typed = text;
          clearTimeout(edit.timer);
          edit.timer = setTimeout(() => keep(edit), keepEditAfter);
        },
      });
      workspace.actions.open(textEditTab(edit.id, name));
      shown();
      return true;
    },
  };
}

/**
 * Sending with an edit still pending keeps the edit first: the send then goes on the next
 * render, once the chips (and the message's markers) name the edited copy, so the old text
 * never goes.
 */
export function useSendAfterEdits(
  flush: () => boolean,
  send: (opposite: boolean) => void,
): (opposite: boolean) => void {
  const [queued, setQueued] = useState<{ opposite: boolean }>();
  const sent = useRef<{ opposite: boolean }>(undefined);
  const latest = useRef(send);
  useLayoutEffect(() => {
    latest.current = send;
  });
  useEffect(() => {
    if (!queued || sent.current === queued) return;
    sent.current = queued;
    latest.current(queued.opposite);
  }, [queued]);
  return (opposite) => (flush() ? setQueued({ opposite }) : send(opposite));
}
