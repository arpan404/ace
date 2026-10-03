import { useConnectionState } from "@ace/client-react";
import { useState } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { DaemonForm } from "@/features/connect/daemon-form.tsx";
import { DaemonHealth } from "./daemon-health.tsx";

const stateLabels = {
  connecting: "Connecting",
  ready: "Connected",
  reconnecting: "Reconnecting",
  offline: "Offline",
  fatal: "Disconnected",
} as const;

/** Which daemon this window uses, a way to point it elsewhere, and the daemon's health. */
export function DaemonSettings() {
  const connection = useDaemonConnection();
  const state = useConnectionState();
  const [editing, setEditing] = useState(false);
  const fake = connection.mode === "fake";
  return (
    <SettingSection label="Daemon">
      <SettingRow
        title={fake ? "Fake daemon (development)" : "Connected daemon"}
        description={
          <>
            <span className="font-mono text-[12px]">{connection.url}</span> · {stateLabels[state]}
          </>
        }
      >
        {!fake && (
          <>
            <Button size="sm" onClick={() => setEditing(!editing)} aria-expanded={editing}>
              Change
            </Button>
            <Button size="sm" variant="ghost" onClick={connection.disconnect}>
              Disconnect
            </Button>
          </>
        )}
      </SettingRow>
      {editing && (
        <div className="border-t py-4">
          <DaemonForm
            url={connection.url}
            remembered={connection.remembered}
            submitLabel="Reconnect"
            onSubmit={(target, remember) => {
              setEditing(false);
              connection.connect(target, remember);
            }}
          />
        </div>
      )}
      <div className="border-t py-4">
        <DaemonHealth />
      </div>
    </SettingSection>
  );
}
