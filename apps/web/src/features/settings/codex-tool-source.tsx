import { SettingsValues, type NativeToolSource } from "@ace/protocol";
import { useId, useState } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { useNativePicker } from "@/lib/native-picker.ts";
import { useWatchedSettingControl } from "./data/use-settings.ts";
import { useSettingsMachine } from "./machine-scope.tsx";
import { DaemonSlot } from "./setting-control.tsx";
import { settingRow } from "./settings-index.ts";

const title = "Plugins and tools from";
const folderSchema = SettingsValues.shape["providers.codex.toolSource"];

/**
 * The folder Codex accounts take the person's plugins, marketplaces and MCP servers from
 * (`providers.codex.toolSource`, ADR 0138). The path shown is the one the daemon reads, so the
 * default reads as the real Codex home. On the daemon's own computer the desktop app's folder
 * picker chooses another; elsewhere the person types its full path.
 */
export function CodexToolSourceRow(props: { source: NativeToolSource }) {
  const control = useWatchedSettingControl("providers.codex.toolSource", title);
  const machine = useSettingsMachine().machine;
  const picker = useNativePicker(machine?.primary ?? true);
  const [typing, setTyping] = useState(false);
  const change = () => {
    if (!picker) {
      setTyping(true);
      return;
    }
    void picker.choose().then((chosen) => {
      if (chosen) control.set(chosen);
    });
  };
  return (
    <SettingRow
      id={settingRow("providers.codex.toolSource").id}
      title={title}
      description={
        <>
          <span className="block break-all font-mono">{props.source.path}</span>
          {!props.source.usable && props.source.reason && (
            <span className="block text-status-needs-you">{props.source.reason}</span>
          )}
        </>
      }
    >
      <DaemonSlot control={control}>
        {typeof control.value === "string" && (
          <Button
            size="sm"
            variant="ghost"
            disabled={control.offline}
            onClick={() => control.set(null)}
          >
            Use default
          </Button>
        )}
        <Button size="sm" variant="secondary" disabled={control.offline} onClick={change}>
          Change…
        </Button>
      </DaemonSlot>
      <FolderDialog
        open={typing}
        initial={props.source.path}
        onOpenChange={setTyping}
        onSave={(path) => {
          setTyping(false);
          control.set(path);
        }}
      />
    </SettingRow>
  );
}

/** Another tool folder by its full path, for a browser or a daemon on another computer. */
function FolderDialog(props: {
  open: boolean;
  initial: string;
  onOpenChange(open: boolean): void;
  onSave(path: string): void;
}) {
  const id = useId();
  const [typed, setTyped] = useState<string>();
  const [problem, setProblem] = useState(false);
  const value = typed ?? props.initial;
  const close = (open: boolean) => {
    if (!open) {
      setTyped(undefined);
      setProblem(false);
    }
    props.onOpenChange(open);
  };
  const save = () => {
    const parsed = folderSchema.safeParse(value.trim());
    if (!parsed.success || parsed.data === null) {
      setProblem(true);
      return;
    }
    setTyped(undefined);
    setProblem(false);
    props.onSave(parsed.data);
  };
  return (
    <Dialog open={props.open} onOpenChange={close}>
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <DialogHeader>
            <DialogTitle>Take Codex's plugins and tools from</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <label htmlFor={id} className="sr-only">
              Folder path
            </label>
            <Input
              id={id}
              value={value}
              className="w-full font-mono"
              aria-invalid={problem || undefined}
              onChange={(event) => {
                setTyped(event.target.value);
                setProblem(false);
              }}
            />
            {problem && (
              <p role="alert" className="mt-2 text-xs text-status-failed">
                Use the folder's full path.
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              Use folder
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
