import { useId, useState } from "react";
import { useClient, useConnectionState } from "@ace/client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { UserBrowserConnection, UserBrowserSettings, UserBrowserStatus } from "@ace/protocol";
import { CopyCommand } from "@/components/copy-command.tsx";
import { SettingNote, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";

const familyNames: Record<string, string> = {
  chrome: "Chrome",
  edge: "Edge",
  brave: "Brave",
  chromium: "Chromium",
  arc: "Arc",
  vivaldi: "Vivaldi",
  opera: "Opera",
  other: "Browser",
};

function connectionTitle(connection: UserBrowserConnection): string {
  const name = familyNames[connection.browser.family] ?? "Browser";
  const major = connection.browser.version.split(".")[0];
  return major ? `${name} ${major}` : name;
}

function connectionSummary(connection: UserBrowserConnection): string {
  const controlled = connection.tabs.filter((tab) => tab.attached).length;
  const shared = connection.tabs.filter((tab) => tab.access === "shared").length;
  if (!connection.tabs.length) return "No tabs shared";
  const parts = [`${shared} shared`];
  if (controlled) parts.push(`${controlled} in use by agents`);
  return parts.join(" · ");
}

/**
 * Settings › Computer use › Use my Chrome (ADR 0084): install the native host and extension,
 * see which browsers are connected, stop agents, revoke. The daemon decides; this shows and asks.
 */
export function UseMyChromeSettings() {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const queries = useQueryClient();
  const [busy, setBusy] = useState<UserBrowserSettings["operation"]>();
  const [error, setError] = useState<string>();
  const [storageReads, setStorageReads] = useDaemonSetting("browser.userChrome.storageReads");
  const storageId = useId();
  const key = [client, "user-browser", "status"];
  const request = async (operation: UserBrowserSettings["operation"]) => {
    const response = await client.request({ type: "user_browser.settings", operation });
    if (response.result.kind === "error") throw new Error(response.result.message);
    return response.result.status;
  };
  const status = useQuery({
    queryKey: key,
    enabled: ready,
    // Browsers connect and tabs change outside ace; a short poll keeps the list honest.
    refetchInterval: 3_000,
    queryFn: () => request("status"),
  });
  const run = async (operation: UserBrowserSettings["operation"]) => {
    setBusy(operation);
    setError(undefined);
    try {
      queries.setQueryData<UserBrowserStatus>(key, await request(operation));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Use my Chrome failed.");
    } finally {
      setBusy(undefined);
    }
  };
  const value = status.data;
  if (!value) return null;
  const installed = value.installed.length > 0;
  const controlled = value.connections.some((connection) =>
    connection.tabs.some((tab) => tab.attached),
  );
  return (
    <SettingSection label="Use my Chrome">
      {!value.supported ? (
        <SettingNote>Use my Chrome is available on macOS and Linux for now.</SettingNote>
      ) : (
        <>
          <SettingRow
            title="Browser connection"
            description={
              installed
                ? `Installed for ${value.installed.map((host) => host.browser).join(", ")}.`
                : "Agents can work in tabs you share from your own browser, with your sign-ins and extensions."
            }
            inline
          >
            <Button
              size="sm"
              variant={installed ? "secondary" : "primary"}
              disabled={busy !== undefined}
              onClick={() => void run("install")}
            >
              {busy === "install" ? "Installing…" : installed ? "Reinstall" : "Install"}
            </Button>
          </SettingRow>
          {value.extensionPath && (
            <SettingRow
              title="Extension"
              description={
                <>
                  Open <CopyCommand command="chrome://extensions" />, turn on Developer mode, choose
                  Load unpacked and pick <CopyCommand command={value.extensionPath} />
                </>
              }
            />
          )}
          {value.connections.length === 0
            ? installed && <SettingRow title="No browser connected" />
            : value.connections.map((connection) => (
                <SettingRow
                  key={connection.connectionId}
                  title={connectionTitle(connection)}
                  description={connectionSummary(connection)}
                />
              ))}
          {installed && (
            <SettingRow
              id="browser.userChrome.storageReads"
              title="Let agents read cookies and site storage"
              description="Off: agents' scripts in your tabs read the page, never its cookies or saved site data."
              htmlFor={storageId}
              inline
            >
              <Switch
                id={storageId}
                checked={storageReads === true}
                disabled={!ready || storageReads === undefined}
                onCheckedChange={(allowed) =>
                  void setStorageReads(allowed).catch((cause: unknown) =>
                    setError(
                      cause instanceof Error ? cause.message : "Couldn't save that setting.",
                    ),
                  )
                }
              />
            </SettingRow>
          )}
          {installed && (
            <SettingRow
              title="Stop or revoke"
              description="Stop releases every tab now. Revoke also disconnects every browser until you install again."
              inline
            >
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={busy !== undefined || !controlled}
                  onClick={() => void run("stop")}
                >
                  Stop
                </Button>
                <Button
                  size="sm"
                  tone="danger"
                  disabled={busy !== undefined}
                  onClick={() => void run("revoke")}
                >
                  Revoke
                </Button>
              </div>
            </SettingRow>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-status-failed">
          {error}
        </p>
      )}
    </SettingSection>
  );
}
