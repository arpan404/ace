import { useEffect, useMemo, useState } from "react";
import { desktopCli, type TerminalCommand } from "@/boot/desktop-cli.ts";
import { SettingRow } from "@/components/setting-row.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useSettingWrite } from "./data/use-settings.ts";
import { settingRow } from "./settings-index.ts";

/** One sentence on whether a terminal runs `ace`, and what to do when it can't. */
export function terminalCommandWords(status: TerminalCommand): string {
  switch (status.state) {
    case "ready":
      return `Run ace from any terminal (${status.command}).`;
    case "added":
      return `Added to PATH in ${status.files.join(" and ")}. Open a new terminal window to use it.`;
    case "off":
      return `Terminals don't find ace. It still runs from ${status.command}.`;
    case "other":
      return `Terminals run another ace at ${status.command}, so ace left PATH as it is.`;
    case "manual":
      return `Add ${status.directory} to PATH to run ace from a terminal.${status.reason ? ` ${status.reason}.` : ""}`;
    case "unavailable":
      return `The ace command isn't installed. ${status.reason}`;
  }
}

/**
 * The desktop app's `ace` command: on, it goes on the terminal's PATH, which the app does on
 * every launch; off takes back what the app added. Nothing in a browser.
 */
export function TerminalCommandRow(props: { scope?: object }) {
  const cli = useMemo(() => desktopCli(props.scope), [props.scope]);
  const [status, setStatus] = useState<TerminalCommand>();
  const write = useSettingWrite("ace command in terminals");
  useEffect(() => {
    let live = true;
    void cli?.status().then(
      (next) => live && setStatus(next),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [cli]);
  if (!cli || !status) return null;
  return (
    <SettingRow
      {...settingRow("app.terminalCommand")}
      description={terminalCommandWords(status)}
      htmlFor="app-terminalCommand"
      inline
    >
      {status.state === "unavailable" ? null : (
        <Switch
          id="app-terminalCommand"
          checked={status.state !== "off"}
          disabled={write.pending}
          onCheckedChange={(on) => write.run(async () => setStatus(await cli.setOnPath(on)))}
        />
      )}
    </SettingRow>
  );
}
