import { useConnectionState } from "@ace/client-react";
import { useId, useState } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { Input } from "@/components/ui/input.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";

/** Comma- or line-separated names, trimmed, each once (case-insensitive). */
export function parseAppList(text: string): string[] {
  const seen = new Set<string>();
  const apps: string[] = [];
  for (const part of text.split(/[,\n]/)) {
    const app = part.trim();
    if (!app || seen.has(app.toLowerCase())) continue;
    seen.add(app.toLowerCase());
    apps.push(app.slice(0, 200));
  }
  return apps.slice(0, 200);
}

/**
 * Apps agents can't use (`computer.blockedApps`): app ids (a macOS bundle id, a Linux
 * desktop-file id, a Windows .exe name or AppUserModelID) or names, saved on Enter or blur.
 * The daemon adds them to its own list (password managers, terminals, ace itself).
 */
/** Windows ids are .exe names or AppUserModelIDs; the desktop bridge sets the platform. */
function windowsHost(): boolean {
  return document.documentElement.dataset.platform === "win32";
}

export function BlockedAppsRow() {
  const id = useId();
  const toast = useToast();
  const ready = useConnectionState() === "ready";
  const [stored, setStored] = useDaemonSetting("computer.blockedApps");
  const [draft, setDraft] = useState<string>();
  const shown = (stored ?? []).join(", ");
  const save = () => {
    if (draft === undefined) return;
    setDraft(undefined);
    const next = parseAppList(draft);
    if (next.join(", ") === shown) return;
    void setStored(next).catch((cause: unknown) =>
      toast.error({
        title: "Couldn't save the apps agents can't use",
        description: cause instanceof Error ? cause.message : undefined,
      }),
    );
  };
  return (
    <SettingRow
      id="computer.blockedApps"
      title="Apps agents can't use"
      description={
        windowsHost()
          ? "Password managers, terminals, File Explorer, Task Manager and ace itself are always off limits. Use app names, .exe names (notepad.exe) or AppUserModelIDs."
          : "Password managers, terminals and ace itself are always off limits."
      }
      htmlFor={id}
    >
      <Input
        id={id}
        value={draft ?? shown}
        placeholder={
          windowsHost() ? "App names or ids, e.g. notepad.exe" : "App names or ids, e.g. Messages"
        }
        disabled={!ready || stored === undefined}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === "Enter") save();
          if (event.key === "Escape") setDraft(undefined);
        }}
        className="w-72"
      />
    </SettingRow>
  );
}
