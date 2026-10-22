import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { openExternal } from "./open-external.ts";

const updateStates = [
  "disabled",
  "idle",
  "checking",
  "current",
  "available",
  "downloading",
  "downloaded",
  "installing",
  "error",
] as const;

/** `UpdateStatus` from the desktop's preload (apps/desktop/src/shared/contract.ts). */
export interface UpdateStatus {
  state: (typeof updateStates)[number];
  currentVersion: string;
  version: string | null;
  releaseUrl: string | null;
  inPlace: boolean;
  percent: number | null;
  waiting: number;
  notes: { version: string; items: string[]; total: number }[];
  olderReleases: number;
  error: { during: "check" | "download" | "install"; message: string } | null;
}

export const releasesUrl = "https://github.com/arpan404/ace/releases";

interface UpdatesBridge {
  onStatus(listener: (status: unknown) => void): () => void;
  onChecked?(listener: (status: unknown) => void): () => void;
  current?(): Promise<unknown>;
  check?(): Promise<unknown>;
  download?(): Promise<unknown>;
  install?(): Promise<unknown>;
  busy?(): Promise<unknown>;
}

function updatesBridge(scope: object): UpdatesBridge | undefined {
  const ace: unknown = Reflect.get(scope, "ace");
  if (typeof ace !== "object" || ace === null || !("updates" in ace)) return undefined;
  const updates: unknown = ace.updates;
  if (typeof updates !== "object" || updates === null) return undefined;
  const call = (name: string) => {
    const value: unknown = Reflect.get(updates, name);
    if (typeof value !== "function") return undefined;
    return () => {
      const result: unknown = Reflect.apply(value, updates, []);
      return Promise.resolve(result);
    };
  };
  const listen = (name: string) => {
    const value: unknown = Reflect.get(updates, name);
    if (typeof value !== "function") return undefined;
    return (listener: (status: unknown) => void) => {
      const stop: unknown = Reflect.apply(value, updates, [listener]);
      return () => {
        if (typeof stop === "function") stop();
      };
    };
  };
  const onStatus = listen("onStatus");
  if (!onStatus) return undefined;
  const onChecked = listen("onChecked");
  const current = call("current");
  const check = call("check");
  const download = call("download");
  const install = call("install");
  const busy = call("busy");
  return {
    onStatus,
    ...(onChecked ? { onChecked } : {}),
    ...(current ? { current } : {}),
    ...(check ? { check } : {}),
    ...(download ? { download } : {}),
    ...(install ? { install } : {}),
    ...(busy ? { busy } : {}),
  };
}

const text = (value: unknown, max: number) =>
  typeof value === "string" && value.length <= max ? value : undefined;
const count = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
const isState = (value: unknown): value is UpdateStatus["state"] =>
  updateStates.some((state) => state === value);

function parseNotes(value: unknown): UpdateStatus["notes"] {
  if (!Array.isArray(value)) return [];
  const list: unknown[] = value;
  return list.flatMap((note) => {
    if (typeof note !== "object" || note === null) return [];
    const version = text(Reflect.get(note, "version"), 80);
    const items: unknown = Reflect.get(note, "items");
    if (!version || !Array.isArray(items)) return [];
    const raw: unknown[] = items;
    const lines = raw.flatMap((item) => {
      const line = text(item, 240);
      return line ? [line] : [];
    });
    return [
      { version, items: lines, total: Math.max(count(Reflect.get(note, "total")), lines.length) },
    ];
  });
}

function parseError(value: unknown): UpdateStatus["error"] {
  if (typeof value !== "object" || value === null) return null;
  const during: unknown = Reflect.get(value, "during");
  const message = text(Reflect.get(value, "message"), 2000);
  if (message === undefined) return null;
  return during === "check" || during === "download" || during === "install"
    ? { during, message }
    : null;
}

/** The desktop's update status, leniently: unknown fields are dropped, bad ones defaulted. */
export function parseUpdateStatus(value: unknown): UpdateStatus | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (name: string): unknown => Reflect.get(value, name);
  const state = field("state");
  if (!isState(state)) return undefined;
  const percent = field("percent");
  return {
    state,
    currentVersion: text(field("currentVersion"), 80) ?? "",
    version: text(field("version"), 80) ?? null,
    releaseUrl: text(field("releaseUrl"), 400) ?? null,
    inPlace: field("inPlace") === true,
    percent: typeof percent === "number" && percent >= 0 && percent <= 100 ? percent : null,
    waiting: count(field("waiting")),
    notes: parseNotes(field("notes")),
    olderReleases: count(field("olderReleases")),
    error: parseError(field("error")),
  };
}

/** A release page (or the release list) in the system browser. */
export function openRelease(url: string, scope: object = globalThis): void {
  void openExternal(url, scope).catch(() => {});
}

/**
 * The page's side of the app's update: the menu's Check for Updates… answers with a toast,
 * a finished download says how to install it, and a Restart that found agents still at work
 * says so. A no-op in a browser.
 */
export function useDesktopUpdates(scope: object = globalThis): void {
  const toast = useToast();
  // Kept across re-subscriptions: `toast` changes as toasts come and go.
  const last = useRef<UpdateStatus["state"] | undefined>(undefined);
  useEffect(() => {
    const bridge = updatesBridge(scope);
    if (!bridge) return;
    const kind = "desktop-update";
    const stopStatus = bridge.onStatus((value) => {
      const status = parseUpdateStatus(value);
      if (!status) return;
      const previous = last.current;
      last.current = status.state;
      const url = status.releaseUrl;
      if (previous === "downloading" && status.state === "downloaded")
        toast.add({
          kind,
          title: "Update downloaded",
          description: "Restart ace from the update button to install it.",
          timeout: 8000,
          ...(url
            ? { actionProps: { children: "Read more", onClick: () => openRelease(url, scope) } }
            : {}),
        });
      if (previous === "installing" && status.state === "downloaded" && status.error)
        toast.add({ kind, title: "Agents are still working", description: status.error.message });
    });
    const stopChecked = bridge.onChecked?.((value) => {
      const status = parseUpdateStatus(value);
      if (!status) return;
      if (status.state === "error")
        toast.error({
          kind,
          title: "Couldn't check for updates",
          description: status.error?.message ?? "Check your connection and try again.",
        });
      else if (status.state === "disabled")
        toast.add({ kind, title: "Automatic updates are not available in this build." });
      else if (status.state === "current")
        toast.add({ kind, title: `ace is up to date (${status.currentVersion})`, timeout: 5000 });
      else if (status.version)
        toast.add({
          kind,
          title: `ace ${status.version} is available`,
          description: "The update button beside Settings has what's new.",
          timeout: 6000,
        });
    });
    return () => {
      stopStatus();
      stopChecked?.();
    };
  }, [scope, toast]);
}

export interface DesktopUpdate {
  status: UpdateStatus | undefined;
  check(): Promise<UpdateStatus | undefined>;
  download(): void;
  install(): void;
  /** How many agents on this machine Restart would stop; undefined when unknown. */
  busy(): Promise<number | undefined>;
}

/** Where the app's update stands, and its actions, for the sidebar; undefined in a browser. */
export function useDesktopUpdate(scope: object = globalThis): DesktopUpdate {
  const [status, setStatus] = useState<UpdateStatus | undefined>(undefined);
  const bridge = useRef<UpdatesBridge | undefined>(undefined);
  useEffect(() => {
    const updates = updatesBridge(scope);
    bridge.current = updates;
    if (!updates) return;
    let live = true;
    let heard = false;
    const stop = updates.onStatus((value) => {
      const next = parseUpdateStatus(value);
      if (!next) return;
      heard = true;
      setStatus(next);
    });
    // A page loaded (or reloaded) after the last event asks once; a live event wins.
    void updates
      .current?.()
      .then((value) => {
        const next = parseUpdateStatus(value);
        if (live && !heard && next) setStatus(next);
      })
      .catch(() => {});
    return () => {
      live = false;
      stop();
    };
  }, [scope]);
  return {
    status,
    check: async () => {
      try {
        return parseUpdateStatus(await bridge.current?.check?.());
      } catch {
        return undefined;
      }
    },
    download: () => void bridge.current?.download?.().catch(() => {}),
    install: () => void bridge.current?.install?.().catch(() => {}),
    busy: async () => {
      try {
        const value: unknown = await bridge.current?.busy?.();
        return typeof value === "number" && Number.isInteger(value) && value >= 0
          ? value
          : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
