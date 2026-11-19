import type { SpadeComputerTab } from "@ace/protocol";

/**
 * One surface of a bot's computer as Spade takes it
 * (`PUT /v1/agents/{id}/computer/surfaces/{browser|screen}`): whether it is live, what it shows,
 * the thread and tab the apps stream it from, and whether the person did something while driving.
 */
export interface SurfaceReport {
  live: boolean;
  title?: string;
  url?: string;
  tab_id?: string;
  /** `user`: the tab is in the person's own Chrome; absent for ace's browser. */
  backend?: "user";
  thread_id: string;
  person_acted?: boolean;
  /** `exclusive` while the person took over, else `cowork` (ADR 0143). */
  mode: "cowork" | "exclusive";
  /** The person used this surface within the last 3 s; the bot's actions there wait. */
  person_active?: boolean;
}

export type SurfaceKind = "browser" | "screen";

/** The bot's browser: live with a tab open, showing the tab it is on (else its last tab). */
export function browserReport(
  threadId: string,
  tabs: readonly SpadeComputerTab[],
  active: { tabId: string; backend?: "user" } | undefined,
  personDriving: boolean,
): SurfaceReport {
  // A tab is its id in its backend: ace's browser and the person's Chrome number tabs apart.
  const tab =
    tabs.find((each) => each.tabId === active?.tabId && each.backend === active.backend) ??
    tabs.at(-1);
  return {
    live: tab !== undefined,
    ...(tab
      ? {
          title: tab.title || tab.url,
          url: tab.url,
          tab_id: tab.tabId,
          ...(tab.backend ? { backend: tab.backend } : {}),
        }
      : {}),
    thread_id: threadId,
    ...(personDriving || tab?.personActive ? { person_acted: true } : {}),
    mode: personDriving ? "exclusive" : "cowork",
    person_active: tab?.personActive ?? false,
  };
}

/** The bot's screen: live while it uses an app, titled with the apps it uses. */
export function screenReport(
  threadId: string,
  apps: readonly string[],
  personDriving: boolean,
  personActive = false,
): SurfaceReport {
  return {
    live: apps.length > 0,
    ...(apps.length ? { title: apps.join(", ") } : {}),
    thread_id: threadId,
    ...(personDriving || personActive ? { person_acted: true } : {}),
    mode: personDriving ? "exclusive" : "cowork",
    person_active: personActive,
  };
}

/** Lets through only a report that differs from the last one sent for that bot and surface. */
export class ReportChanges {
  private readonly last = new Map<string, string>();
  changed(bot: string, kind: SurfaceKind, report: SurfaceReport): boolean {
    const key = `${kind}\u0000${bot}`;
    const text = JSON.stringify(report);
    if (this.last.get(key) === text) return false;
    this.last.set(key, text);
    return true;
  }
}
