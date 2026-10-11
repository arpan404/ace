import { useEffect } from "react";
import { useToast } from "@/components/ui/toast.tsx";

/** `UpdateStatus` from the desktop's preload (apps/desktop/src/shared/contract.ts). */
type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "current"; version: string }
  | { state: "available"; version: string; url: string }
  | { state: "error"; message: string };

interface UpdatesBridge {
  onStatus(listener: (status: unknown) => void): () => void;
  openExternal?(url: string): unknown;
}

function updatesBridge(scope: object): UpdatesBridge | undefined {
  const ace: unknown = Reflect.get(scope, "ace");
  if (typeof ace !== "object" || ace === null || !("updates" in ace)) return undefined;
  const updates: unknown = ace.updates;
  if (typeof updates !== "object" || updates === null || !("onStatus" in updates)) return undefined;
  const onStatus = updates.onStatus;
  if (typeof onStatus !== "function") return undefined;
  const shell: unknown = "shell" in ace ? ace.shell : undefined;
  const open =
    typeof shell === "object" && shell !== null && "openExternal" in shell
      ? shell.openExternal
      : undefined;
  return {
    onStatus: (listener) => {
      const stop: unknown = Reflect.apply(onStatus, updates, [listener]);
      return () => {
        if (typeof stop === "function") stop();
      };
    },
    ...(typeof open === "function"
      ? { openExternal: (url: string) => Reflect.apply(open, shell, [url]) }
      : {}),
  };
}

export function parseUpdateStatus(value: unknown): UpdateStatus | undefined {
  if (typeof value !== "object" || value === null || !("state" in value)) return undefined;
  const field = (name: string) => {
    const read: unknown = Reflect.get(value, name);
    return typeof read === "string" ? read : undefined;
  };
  const version = field("version");
  const url = field("url");
  const message = field("message");
  switch (value.state) {
    case "idle":
      return { state: "idle" };
    case "checking":
      return { state: "checking" };
    case "current":
      return version === undefined ? undefined : { state: "current", version };
    case "available":
      return version === undefined || url === undefined
        ? undefined
        : { state: "available", version, url };
    case "error":
      return { state: "error", message: message ?? "Unknown error" };
    default:
      return undefined;
  }
}

/**
 * The desktop's "Check for Updates…" (and its background checks) answer here: one toast that
 * says checking, then the result. An available update stays until dismissed, with Download.
 * A no-op in a browser.
 */
export function useDesktopUpdates(scope: object = globalThis): void {
  const toast = useToast();
  useEffect(() => {
    const bridge = updatesBridge(scope);
    if (!bridge) return;
    return bridge.onStatus((value) => {
      const status = parseUpdateStatus(value);
      if (!status || status.state === "idle") return;
      const common = {
        kind: "desktop-update",
      };
      if (status.state === "error") {
        toast.error({
          ...common,
          title: "Couldn't check for updates",
          description: "Check your connection and try Check for Updates again.",
        });
        return;
      }
      const options =
        status.state === "checking"
          ? { title: "Checking for updates…", timeout: 0 }
          : status.state === "current"
            ? { title: `ace is up to date (${status.version})`, timeout: 5000 }
            : {
                title: `ace ${status.version} is available`,
                timeout: 0,
                actionProps: {
                  children: "Download",
                  onClick: () => {
                    if (bridge.openExternal) void bridge.openExternal(status.url);
                    else window.open(status.url, "_blank", "noopener");
                  },
                },
              };
      toast.add({ ...common, ...options });
    });
  }, [scope, toast]);
}
