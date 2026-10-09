import type { InstalledEditor } from "@ace/protocol";
import { readJson, writeJson } from "@ace/ui-core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useConnectionState } from "@ace/client-react";
import { editorIconReader } from "@/boot/editor-launch.ts";
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
      return result.editors;
    },
  });
  const editors = ready && !query.error && !query.isFetching ? query.data : undefined;
  return {
    editors,
    current: editors?.find((editor) => editor.id === picked) ?? editors?.[0],
    choose: (id) => {
      setPicked(id);
      writeJson(storage, storageKey, id);
    },
    error: query.error,
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
 * An installed editor's own icon as this computer's OS draws it (a PNG data URL): the desktop
 * app reads it from the app itself, so nothing is bundled. Undefined in a browser, which can't
 * ask, or while it is read; null when the OS has none.
 */
export function useEditorAppIcon(id: string): string | null | undefined {
  const read = editorIconReader();
  return useQuery({
    queryKey: ["editor-icon", id],
    queryFn: () => (read ? read(id) : null),
    enabled: read !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  }).data;
}
