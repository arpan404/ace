import { useClient, useSidebarAll } from "@ace/client-react";
import type { SidebarReader } from "@ace/client";
import { admissionWords } from "@ace/ui-core/host-care";
import { readJson, writeJson } from "@ace/ui-core";
import * as z from "zod/mini";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { menuSeparator } from "@/components/ui/menu-styles.ts";
import { desktopTray, type DesktopTray } from "@/boot/desktop-tray.ts";
import { setPaused, useAdmission } from "@/lib/admission.ts";
import { useLiveList } from "@/lib/live-connection.ts";
import { useStartupShell } from "@/lib/startup/startup.tsx";
import { useHostIdentity } from "@/lib/host-name.ts";
import { useOptionalStorage } from "@/lib/layout.tsx";
import { part } from "@/lib/suit-part.ts";
import { TrayAgents } from "./tray-agents.tsx";
import { TrayComputerUse, useAppsInUse } from "./tray-computer-use.tsx";
import { TrayCommand } from "./tray-parts.tsx";
import { TrayUsage } from "./tray-usage.tsx";
import { noTrayThreads, sameTrayThreads, trayHeadline, trayThreads } from "./tray-threads.ts";
import "./tray.css";

const Tab = z.enum(["agents", "apps", "usage"]);
type Tab = z.infer<typeof Tab>;
/** The tab the popover last showed on this device; it opens there again, after a restart too. */
const tabKey = "ace.tray.tab";

const pickThreads = (reader: SidebarReader) => trayThreads(reader.ids, (id) => reader.thread(id));

/** What does nothing outside the desktop app (a browser opening `/tray` by hand). */
const noTray: DesktopTray = { open() {}, fit() {}, hide() {}, quit() {} };

/**
 * The menu-bar popover (macOS), in the desktop app's panel under ace's icon. It is drawn on the
 * system's popover material with the theme's (or Suit's) glass over it, as a menu-bar module:
 * a headline, a segmented switch between who needs the person and what works, the apps agents
 * use, and usage, then the menu's own Open, Pause new work and Quit commands. It sizes its window
 * to itself (`tray.fit`); Esc closes it and ⌘O opens the app.
 */
export function TrayPage() {
  useStartupShell(true);
  const tray = desktopTray() ?? noTray;
  const storage = useOptionalStorage();
  const [tab, setShown] = useState<Tab>(() => readJson(storage, tabKey, Tab, "agents"));
  const setTab = (next: Tab) => {
    setShown(next);
    writeJson(storage, tabKey, next);
  };
  // A list the daemon hasn't confirmed claims no status (AGENTS.md: never show stale work).
  const live = useLiveList();
  const listed = useSidebarAll(pickThreads, sameTrayThreads) ?? noTrayThreads;
  const threads = live ? listed : noTrayThreads;
  const headline = trayHeadline(threads);
  const apps = useAppsInUse();
  const frame = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const fit = () => tray.fit(element.getBoundingClientRect().height);
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [tray]);
  useWindowKeys(tray);
  const inUse = apps.live.length;
  return (
    <div
      ref={frame}
      {...part("popover")}
      className="ace-floating flex w-full cursor-default flex-col p-1 text-ui select-none"
    >
      <header className="flex h-9 items-baseline gap-2 px-2.5 pt-2.5">
        <h1 className="text-ui font-semibold text-foreground">
          {live ? headline.working : "Syncing…"}
        </h1>
        {headline.needsYou && (
          <span data-tone="needs-you" className="text-meta font-medium text-(--tone-text)">
            {headline.needsYou}
          </span>
        )}
      </header>
      <SegmentedControl<Tab>
        label="Show"
        size="sm"
        value={tab}
        onValueChange={setTab}
        className="mx-1.5 mt-1 mb-1.5 grid"
        options={[
          { value: "agents", label: "Agents" },
          { value: "apps", label: inUse ? `Computer use ${inUse}` : "Computer use" },
          { value: "usage", label: "Usage" },
        ]}
      />
      <div role="region" aria-label={tab}>
        {tab === "agents" && <TrayAgents threads={threads} live={live} tray={tray} />}
        {tab === "apps" && <TrayComputerUse apps={apps} tray={tray} />}
        {tab === "usage" && <TrayUsage tray={tray} />}
      </div>
      <div className={menuSeparator} />
      <TrayCommand label="Open ace" shortcut="⌘O" onClick={() => tray.open()} />
      <PauseCommand />
      <div className={menuSeparator} />
      <TrayCommand label="Quit ace" shortcut="⌘Q" onClick={() => tray.quit(false)} />
      <TrayCommand label="Quit ace completely" onClick={() => tray.quit(true)} />
    </div>
  );
}

/**
 * The window is the popover: its page lets the system's material through (tray.css), Esc closes
 * it and ⌘O opens the app.
 */
function useWindowKeys(tray: DesktopTray): void {
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.window = "tray";
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") tray.hide();
      else if (event.metaKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        tray.open();
      }
    };
    addEventListener("keydown", keys);
    return () => {
      removeEventListener("keydown", keys);
      delete root.dataset.window;
    };
  }, [tray]);
}

/** Pause new work, or Resume, as the daemon's admission says; nothing until it has said. */
function PauseCommand() {
  const client = useClient();
  const admission = useAdmission(client);
  const machine = useHostIdentity()?.displayName ?? "this computer";
  const [pending, setPending] = useState(false);
  if (!admission) return null;
  const words = admissionWords(admission);
  return (
    <TrayCommand
      label={words.action}
      disabled={pending || !words.canChange}
      onClick={() => {
        setPending(true);
        void setPaused(client, !words.paused, machine).finally(() => setPending(false));
      }}
    />
  );
}
