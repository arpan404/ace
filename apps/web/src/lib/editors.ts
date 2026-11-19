import type { InstalledEditor } from "@ace/protocol";
import { readJson, writeJson } from "@ace/ui-core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useConnectionState } from "@ace/client-react";
import { appIconReader, editorIconReader } from "@/boot/editor-launch.ts";
import { z } from "zod";
import { useDaemonQuery } from "./daemon-query.ts";
import { useLayout } from "./layout.tsx";

const storageKey = "ace.editor";

/**
 * The editors installed on the daemon's machine (`workspace.request` `editors.list`) and the one
 * this device opens by default. The default is a device preference, so it stays in local storage;
 * until one is picked it is the first editor the daemon found.
 */
export function useEditors(): {
  editors: readonly InstalledEditor[] | undefined;
  current: InstalledEditor | undefined;
  choose(id: string): void;
  error: Error | null;
  unavailable: string | undefined;
  /** The daemon machine's file manager by name ("Finder"), for `host.open`'s files app. */
  fileManager: string | undefined;
  /** The terminals installed there, which open through `host.open`; empty until listed. */
  terminals: readonly InstalledEditor[];
} {
  const { storage } = useLayout();
  const ready = useConnectionState() === "ready";
  const [picked, setPicked] = useState(() => readJson(storage, storageKey, z.string(), ""));
  const query = useDaemonQuery({
    queryKey: ["daemon", "editors"],
    staleTime: 0,
    retry: false,
    read: async (client, signal) => {
      const reply = await client.request(
        { type: "workspace.request", operation: { op: "editors.list" } },
        { signal },
      );
      const result = reply.result;
      if (result.kind === "error") throw new Error(result.code);
      if (result.kind !== "editors") throw new Error("Unexpected editor discovery response");
      return result;
    },
  });
  const editors = ready && !query.error && !query.isFetching ? query.data?.editors : undefined;
  return {
    editors,
    current: editors?.find((editor) => editor.id === picked) ?? editors?.[0],
    choose: (id) => {
      setPicked(id);
      writeJson(storage, storageKey, id);
    },
    error: query.error,
    fileManager: ready && !query.error && !query.isFetching ? query.data?.fileManager : undefined,
    terminals: (editors && query.data?.terminals) ?? [],
    unavailable: !ready
      ? "Connect to this machine to list editors"
      : query.error
        ? "Couldn't list editors. Try again."
        : !editors
          ? "Looking for editors…"
          : !editors.length
            ? "No editors installed"
            : undefined,
  };
}

/**
 * An installed app's own icon as this computer's OS draws it (a PNG data URL): the desktop app
 * reads it from the app itself, so nothing is bundled. An editor the desktop app knows is read
 * by its id; any other app by `app`, the bundle or `.exe` the daemon found. Undefined in a
 * browser, which can't ask, or while it is read; null when the OS has none.
 */
export function useEditorAppIcon(id: string, app?: string): string | null | undefined {
  const byId = editorIconReader();
  const byPath = appIconReader();
  return useQuery({
    queryKey: ["editor-icon", id, app ?? ""],
    queryFn: async () => {
      const own = byId ? await byId(id) : null;
      return own ?? (app && byPath ? byPath(app) : null);
    },
    enabled: byId !== undefined || byPath !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  }).data;
}
