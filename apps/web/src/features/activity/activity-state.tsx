import { useNavigate, useSearch } from "@tanstack/react-router";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { readJson, writeJson } from "@ace/ui-core";
import * as z from "zod/mini";
import { WaitingSinceProvider } from "./waiting-since.tsx";

export type ActivityTab = "all" | "needs" | "mentions" | "runs";
const ActivityView = z.object({
  tab: z.enum(["all", "needs", "mentions", "runs"]),
  project: z.optional(z.string()),
});

// Card keys live in a module of their own, light enough for the shell's notifier.
export { eventKey, interactionKey, readIdOf, runKey } from "@/lib/activity-item-keys.ts";

interface ActivityState {
  tab: ActivityTab;
  setTab(tab: ActivityTab): void;
  /** The card J/K, A/D and 1–3 act on; the matching sidebar row is selected. */
  focused: string | undefined;
  /** The page default follows the inbox until the person chooses a card. */
  automaticFocus: boolean;
  /** Focus a card in the Needs-you list (from keys or a pointer on the card). */
  focusCard: Dispatch<SetStateAction<string | undefined>>;
  /** Set the displayed card's key without turning the page default into a user choice. */
  focusShownCard(key: string): void;
  /**
   * A Needs-you row was chosen: focus its card in the list, leaving any single item shown.
   * Rows outside this slice call it; the name is theirs.
   */
  setFocused(key: string): void;
  /** The item shown on its own in the main column (`/activity?item=`), if any. */
  item: string | undefined;
  /** Show one item on its own; each choice is a history entry, so Back returns to the last. */
  selectItem(key: string | undefined): void;
  /** Project filter from the header; undefined shows every project. */
  project: string | undefined;
  setProject(project: string | undefined): void;
  /** Items picked for a batch action (X, Shift-click), by card key. */
  picked: ReadonlySet<string>;
  togglePicked(key: string): void;
  clearPicked(): void;
}

const Context = createContext<ActivityState | undefined>(undefined);
const viewKey = "ace.activity.view";
const session = () => (typeof sessionStorage === "undefined" ? undefined : sessionStorage);

/**
 * View state for Activity, shared by its sidebar and main column. The tab and project filter
 * last for the browser session; the shown item lives in the URL.
 */
export function ActivityProvider(props: { children: ReactNode }) {
  const [view, setView] = useState(() =>
    readJson(session(), viewKey, ActivityView, { tab: "all" as ActivityTab }),
  );
  const [focus, setFocus] = useState<{ key: string | undefined; automatic: boolean }>({
    key: undefined,
    automatic: true,
  });
  const focusCard = useCallback<Dispatch<SetStateAction<string | undefined>>>(
    (update) =>
      setFocus((current) => {
        const key = typeof update === "function" ? update(current.key) : update;
        if (typeof update === "function" && key === current.key) return current;
        return key === current.key && current.automatic === (key === undefined)
          ? current
          : { key, automatic: key === undefined };
      }),
    [],
  );
  const focusShownCard = useCallback(
    (key: string) => setFocus((current) => (current.key === key ? current : { ...current, key })),
    [],
  );
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const search: { item?: unknown } = useSearch({ strict: false });
  const item = typeof search.item === "string" ? search.item : undefined;
  const navigate = useNavigate();
  const save = useCallback((next: z.infer<typeof ActivityView>) => {
    setView(next);
    writeJson(session(), viewKey, next);
  }, []);
  const selectItem = useCallback(
    (key: string | undefined) =>
      void navigate({ to: "/activity", search: key ? { item: key } : {} }),
    [navigate],
  );
  const value = useMemo<ActivityState>(
    () => ({
      tab: view.tab,
      setTab: (tab) => {
        save({ ...view, tab });
        focusCard(undefined);
        selectItem(undefined);
      },
      project: view.project,
      setProject: (project) => {
        save(project === undefined ? { tab: view.tab } : { tab: view.tab, project });
        focusCard(undefined);
        selectItem(undefined);
      },
      focused: focus.key,
      automaticFocus: focus.automatic,
      focusCard,
      focusShownCard,
      setFocused(key) {
        focusCard(key);
        if (item !== undefined) selectItem(undefined);
      },
      item,
      selectItem,
      picked,
      togglePicked: (key) =>
        setPicked((current) => {
          const next = new Set(current);
          if (!next.delete(key)) next.add(key);
          return next;
        }),
      clearPicked: () => setPicked(new Set()),
    }),
    [view, save, focus, focusCard, focusShownCard, item, selectItem, picked],
  );
  return (
    <Context.Provider value={value}>
      <WaitingSinceProvider>{props.children}</WaitingSinceProvider>
    </Context.Provider>
  );
}

export function useActivityState(): ActivityState {
  const value = useContext(Context);
  if (!value) throw new Error("useActivityState needs an <ActivityProvider>");
  return value;
}

/** True when an item from `project` passes the header's project filter. */
export function inProject(filter: string | undefined, project: string | undefined): boolean {
  return filter === undefined || project === filter;
}
