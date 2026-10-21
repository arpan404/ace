import { useConnectionState } from "@ace/client-react";
import { useState } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { DaemonForm } from "@/features/connect/index.ts";

const stateLabels = {
  connecting: "Connecting",
  starting: "Starting",
  ready: "Connected",
  reconnecting: "Reconnecting",
  offline: "Offline",
  fatal: "Disconnected",
} as const;

/**
 * Which computer this window talks to, and a way to point it elsewhere. It belongs to this
 * device: another window may use another computer. Diagnostics live under Advanced.
 */
/** The address without its scheme or path: what the person typed when they connected. */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export function DaemonSettings() {
  const connection = useDaemonConnection();
  const state = useConnectionState();
  const [editing, setEditing] = useState(false);
  const fake = connection.mode === "fake";
  return (
    <SettingSection label="Connection" scope="device">
      <SettingRow
        id="daemon.connection"
        title="Computer connection"
        description={
          fake ? "Demo data in this page" : `${stateLabels[state]} · ${hostOf(connection.url)}`
        }
      >
        {!fake && (
          <>
            <Button size="sm" onClick={() => setEditing(!editing)} aria-expanded={editing}>
              Change
            </Button>
            <Button size="sm" variant="secondary" onClick={connection.disconnect}>
              Disconnect
            </Button>
          </>
        )}
      </SettingRow>
      {editing && (
        <div className="py-4">
          <DaemonForm
            url={connection.url}
            token={connection.token}
            pairedDeviceId={connection.pairedDeviceId}
            remembered={connection.remembered}
            submitLabel="Reconnect"
            onSubmit={(target, remember) => {
              setEditing(false);
              connection.connect(target, remember);
            }}
          />
        </div>
      )}
    </SettingSection>
  );
}
