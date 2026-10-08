import {
  CodeIcon,
  CursorIcon,
  FileCodeIcon,
  LightningIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import type { InstalledEditor } from "@ace/protocol";
import { readJson, writeJson } from "@ace/ui-core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
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
} {
  const { storage } = useLayout();
  const [picked, setPicked] = useState(() => readJson(storage, storageKey, z.string(), ""));
  const query = useDaemonQuery({
    queryKey: ["daemon", "editors"],
    staleTime: 5 * 60_000,
    read: async (client, signal) => {
      const reply = await client.request(
        { type: "workspace.request", operation: { op: "editors.list" } },
        { signal },
      );
      const result = reply.result;
      if (result.kind === "error") throw new Error(result.code);
      return result.kind === "editors" ? result.editors : [];
    },
  });
  const editors = query.data;
  return {
    editors,
    current: editors?.find((editor) => editor.id === picked) ?? editors?.[0],
    choose: (id) => {
      setPicked(id);
      writeJson(storage, storageKey, id);
    },
    error: query.error,
  };
}

const editorIcons: Record<string, PhosphorIcon> = {
  code: CodeIcon,
  cursor: CursorIcon,
  zed: LightningIcon,
};

/** An editor's glyph: its own where the design has one, a code file otherwise. */
export function editorIcon(id: string | undefined): PhosphorIcon {
  return editorIcons[id ?? ""] ?? FileCodeIcon;
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
