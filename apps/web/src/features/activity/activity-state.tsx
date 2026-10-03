import { createContext, useContext, useMemo, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";

export type ActivityTab = "all" | "needs" | "mentions" | "automations";

/** Card keys shared by the sidebar rows and the Needs-you cards. */
export const interactionKey = (threadId: string, interactionId: string) =>
  `interaction:${threadId}:${interactionId}`;
export const eventKey = (eventId: string) => `event:${eventId}`;

interface ActivityState {
  tab: ActivityTab;
  setTab(tab: ActivityTab): void;
  /** The card J/K, A/D and 1–3 act on; the matching sidebar row is selected. */
  focused: string | undefined;
  setFocused: Dispatch<SetStateAction<string | undefined>>;
  /** Project filter from the header; undefined shows every project. */
  project: string | undefined;
  setProject(project: string | undefined): void;
}

const Context = createContext<ActivityState | undefined>(undefined);

/** View state for Activity, shared by its sidebar and main column. Not persisted. */
export function ActivityProvider(props: { children: ReactNode }) {
  const [tab, setTab] = useState<ActivityTab>("all");
  const [focused, setFocused] = useState<string>();
  const [project, setProject] = useState<string>();
  const value = useMemo(
    () => ({ tab, setTab, focused, setFocused, project, setProject }),
    [tab, focused, project],
  );
  return <Context.Provider value={value}>{props.children}</Context.Provider>;
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
