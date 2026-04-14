import { LaptopIcon, LinkIcon, ScanLineIcon, Trash2Icon } from "lucide-react";
import QRCode from "qrcode";
import { useCallback, useEffect, useMemo, useState } from "react";

import { isElectron } from "../../env";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  buildHostRelayConnectionString,
  connectToWsHost,
  createHostRelayDevice,
  createRemoteHostInstance,
  isHostConnectionActive,
  listHostRelayDevices,
  loadRemoteHostInstances,
  normalizeWsUrl,
  parseHostConnectionQrPayload,
  persistRemoteHostInstances,
  readHostPairingAdvertisedEndpoint,
  resolveActiveWsUrl,
  resolveHostConnectionWsUrl,
  resolveLocalDeviceWsUrl,
  resolveRelayHostConnection,
  revokeHostRelayDevice,
  splitWsUrlAuthToken,
  type RelayDeviceIcon,
  type RelayDeviceView,
  type RemoteHostInstance,
} from "../../lib/remoteHosts";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

interface HostDraftState {
  readonly name: string;
  readonly wsUrl: string;
  readonly authToken: string;
}

interface RelayDraftState {
  readonly name: string;
  readonly icon: RelayDeviceIcon;
}

const EMPTY_HOST_DRAFT: HostDraftState = {
  name: "",
  wsUrl: "",
  authToken: "",
};

const EMPTY_RELAY_DRAFT: RelayDraftState = {
  name: "",
  icon: "iphone",
};

const RELAY_ICON_OPTIONS: ReadonlyArray<{
  readonly icon: RelayDeviceIcon;
  readonly label: string;
}> = [
  { icon: "iphone", label: "Phone" },
  { icon: "ipad", label: "Tablet" },
  { icon: "laptop", label: "Laptop" },
  { icon: "desktop", label: "Desktop" },
  { icon: "watch", label: "Watch" },
];

const URL_MODE_MAX_HOSTS = 1;

function normalizeHostsForMode(hosts: ReadonlyArray<RemoteHostInstance>, desktopMode: boolean) {
  if (desktopMode) {
    return [...hosts];
  }
  return hosts.slice(0, URL_MODE_MAX_HOSTS);
}

function relayIconLabel(icon: RelayDeviceIcon): string {
  return RELAY_ICON_OPTIONS.find((option) => option.icon === icon)?.label ?? "Phone";
}

function resolveRelayUrlFromWs(wsUrl: string): string {
  const parsed = new URL(wsUrl);
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  parsed.pathname = "/v1/resolve";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function DevicesSettingsPanel() {
  const desktopMode = isElectron;
  const [hosts, setHosts] = useState<RemoteHostInstance[]>(() =>
    normalizeHostsForMode(loadRemoteHostInstances(), desktopMode),
  );
  const [hostDraft, setHostDraft] = useState<HostDraftState>(EMPTY_HOST_DRAFT);
  const [importPayload, setImportPayload] = useState("");
  const [importingHost, setImportingHost] = useState(false);
  const [advertisedLocalWsUrl, setAdvertisedLocalWsUrl] = useState<string | null>(null);
  const [relayHostToken, setRelayHostToken] = useState<string | null>(null);
  const [relayResolveUrl, setRelayResolveUrl] = useState<string | null>(null);
  const [relayDevices, setRelayDevices] = useState<readonly RelayDeviceView[]>([]);
  const [relayDeviceError, setRelayDeviceError] = useState<string | null>(null);
  const [loadingRelayDevices, setLoadingRelayDevices] = useState(false);
  const [creatingRelayDevice, setCreatingRelayDevice] = useState(false);
  const [revokingRelayDeviceId, setRevokingRelayDeviceId] = useState<string | null>(null);
  const [relayDraft, setRelayDraft] = useState<RelayDraftState>(EMPTY_RELAY_DRAFT);
  const [visibleRelayQrDeviceId, setVisibleRelayQrDeviceId] = useState<string | null>(null);
  const [visibleRelayQrDataUrl, setVisibleRelayQrDataUrl] = useState<string | null>(null);
  const activeWsUrl = useMemo(() => resolveActiveWsUrl(), []);
  const localDeviceConnection = useMemo(() => splitWsUrlAuthToken(resolveLocalDeviceWsUrl()), []);
  const localAdvertisedWsUrl = advertisedLocalWsUrl ?? localDeviceConnection.wsUrl;
  const localControlConnectionUrl = useMemo(
    () => resolveHostConnectionWsUrl(localDeviceConnection),
    [localDeviceConnection],
  );
  const localShareConnectionUrl = useMemo(
    () =>
      resolveHostConnectionWsUrl({
        wsUrl: localAdvertisedWsUrl,
        authToken: localDeviceConnection.authToken,
      }),
    [localAdvertisedWsUrl, localDeviceConnection.authToken],
  );
  const localIsActive = useMemo(
    () => localControlConnectionUrl === activeWsUrl,
    [activeWsUrl, localControlConnectionUrl],
  );
  const { copyToClipboard } = useCopyToClipboard<{ readonly label: string }>({
    onCopy: ({ label }) => {
      toastManager.add({
        type: "success",
        title: `${label} copied.`,
      });
    },
    onError: (error, { label }) => {
      toastManager.add({
        type: "error",
        title: `Could not copy ${label.toLowerCase()}.`,
        description: error.message,
      });
    },
  });

  const saveHosts = useCallback(
    (nextHosts: RemoteHostInstance[]) => {
      const normalizedHosts = normalizeHostsForMode(nextHosts, desktopMode);
      setHosts(normalizedHosts);
      persistRemoteHostInstances(normalizedHosts);
    },
    [desktopMode],
  );

  useEffect(() => {
    let cancelled = false;
    void readHostPairingAdvertisedEndpoint({
      wsUrl: localDeviceConnection.wsUrl,
      ...(localDeviceConnection.authToken ? { authToken: localDeviceConnection.authToken } : {}),
    })
      .then((endpoint) => {
        if (cancelled) {
          return;
        }
        setAdvertisedLocalWsUrl(endpoint.wsUrl);
      })
      .catch(() => {
        if (!cancelled) {
          setAdvertisedLocalWsUrl(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [localDeviceConnection.authToken, localDeviceConnection.wsUrl]);

  const refreshRelayDevices = useCallback(async () => {
    setLoadingRelayDevices(true);
    try {
      const snapshot = await listHostRelayDevices({
        wsUrl: localAdvertisedWsUrl,
        ...(localDeviceConnection.authToken ? { authToken: localDeviceConnection.authToken } : {}),
      });
      setRelayHostToken(snapshot.hostToken);
      setRelayResolveUrl(snapshot.relayUrl);
      setRelayDevices(snapshot.devices);
      setRelayDeviceError(null);
    } catch (error) {
      setRelayDeviceError(error instanceof Error ? error.message : "Could not load relay devices.");
    } finally {
      setLoadingRelayDevices(false);
    }
  }, [localAdvertisedWsUrl, localDeviceConnection.authToken]);

  useEffect(() => {
    void refreshRelayDevices();
  }, [refreshRelayDevices]);

  useEffect(() => {
    const handle = window.setInterval(() => {
      void refreshRelayDevices();
    }, 15_000);
    return () => window.clearInterval(handle);
  }, [refreshRelayDevices]);

  const resolveRelayConnectionString = useCallback(
    (device: RelayDeviceView) => {
      const relayUrl = relayResolveUrl ?? resolveRelayUrlFromWs(localAdvertisedWsUrl);
      const hostToken = relayHostToken?.trim() ?? "";
      if (relayUrl.length === 0) {
        throw new Error("Relay endpoint is unavailable.");
      }
      if (hostToken.length === 0) {
        throw new Error("Relay host token is unavailable.");
      }
      return buildHostRelayConnectionString({
        name: device.name,
        relayUrl,
        hostToken,
        apiKey: device.apiKey,
      });
    },
    [localAdvertisedWsUrl, relayHostToken, relayResolveUrl],
  );

  const visibleRelayDevice = useMemo(
    () => relayDevices.find((device) => device.deviceId === visibleRelayQrDeviceId) ?? null,
    [relayDevices, visibleRelayQrDeviceId],
  );

  useEffect(() => {
    if (!visibleRelayDevice) {
      setVisibleRelayQrDataUrl(null);
      return;
    }
    let cancelled = false;
    let payload = "";
    try {
      payload = resolveRelayConnectionString(visibleRelayDevice);
    } catch {
      setVisibleRelayQrDataUrl(null);
      return;
    }
    void QRCode.toDataURL(payload, {
      margin: 1,
      width: 220,
    })
      .then((dataUrl) => {
        if (!cancelled) {
          setVisibleRelayQrDataUrl(dataUrl);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setVisibleRelayQrDataUrl(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [resolveRelayConnectionString, visibleRelayDevice]);

  const upsertHost = useCallback(
    (draft: { readonly name?: string; readonly wsUrl: string; readonly authToken?: string }) => {
      const created = createRemoteHostInstance({
        wsUrl: draft.wsUrl,
        ...(draft.name?.trim() ? { name: draft.name } : {}),
        ...(draft.authToken?.trim() ? { authToken: draft.authToken } : {}),
      });

      if (!desktopMode) {
        const existing = hosts[0];
        const replacedHost =
          existing === undefined
            ? created
            : {
                ...created,
                id: existing.id,
                createdAt: existing.createdAt,
                ...(existing.lastConnectedAt ? { lastConnectedAt: existing.lastConnectedAt } : {}),
              };
        saveHosts([replacedHost]);
        return {
          updated:
            existing !== undefined &&
            (existing.wsUrl !== replacedHost.wsUrl ||
              existing.authToken !== replacedHost.authToken),
        };
      }

      const duplicate = hosts.find(
        (candidate) =>
          candidate.wsUrl === created.wsUrl && candidate.authToken === created.authToken,
      );
      const nextHosts =
        duplicate === undefined
          ? [created, ...hosts]
          : hosts.map((candidate) =>
              candidate.id === duplicate.id
                ? {
                    ...created,
                    id: duplicate.id,
                    createdAt: duplicate.createdAt,
                    ...(duplicate.lastConnectedAt
                      ? { lastConnectedAt: duplicate.lastConnectedAt }
                      : {}),
                  }
                : candidate,
            );
      saveHosts(nextHosts);
      return {
        updated: duplicate !== undefined,
      };
    },
    [desktopMode, hosts, saveHosts],
  );

  const saveHostDraft = useCallback(() => {
    try {
      const result = upsertHost({
        name: hostDraft.name,
        wsUrl: hostDraft.wsUrl,
        authToken: hostDraft.authToken,
      });
      setHostDraft(EMPTY_HOST_DRAFT);
      toastManager.add({
        type: "success",
        title: result.updated ? "Remote host updated." : "Remote host saved.",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not save remote host.",
        description: error instanceof Error ? error.message : "Host details are invalid.",
      });
    }
  }, [hostDraft.authToken, hostDraft.name, hostDraft.wsUrl, upsertHost]);

  const importHostPayload = useCallback(async () => {
    const parsed = parseHostConnectionQrPayload(importPayload);
    if (!parsed) {
      toastManager.add({
        type: "error",
        title: "Invalid connection string.",
        description: "Use a relay connection string, ws/http URL, or host:port.",
      });
      return;
    }
    if (parsed.kind === "direct") {
      try {
        const { wsUrl, authToken: embeddedAuthToken } = splitWsUrlAuthToken(
          normalizeWsUrl(parsed.draft.wsUrl),
        );
        setHostDraft({
          name: parsed.draft.name ?? "",
          wsUrl,
          authToken: parsed.draft.authToken?.trim() || embeddedAuthToken,
        });
        toastManager.add({
          type: "success",
          title: "Connection details imported.",
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Invalid host URL.",
          description: error instanceof Error ? error.message : "Could not parse connection input.",
        });
      }
      return;
    }

    if (parsed.kind === "relay") {
      setImportingHost(true);
      try {
        const resolved = await resolveRelayHostConnection(parsed.relay, {
          requesterName: desktopMode ? "ace desktop" : "ace web",
          ...(hosts[0]?.wsUrl ? { lastKnownWsUrl: hosts[0].wsUrl } : {}),
        });
        const { wsUrl, authToken: embeddedAuthToken } = splitWsUrlAuthToken(
          normalizeWsUrl(resolved.wsUrl),
        );
        upsertHost({
          name: resolved.name ?? parsed.relay.name ?? "",
          wsUrl,
          authToken: resolved.authToken?.trim() || embeddedAuthToken,
        });
        setHostDraft(EMPTY_HOST_DRAFT);
        setImportPayload("");
        toastManager.add({
          type: "success",
          title: "Remote host connected.",
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not resolve relay connection.",
          description: error instanceof Error ? error.message : "Relay connection failed.",
        });
      } finally {
        setImportingHost(false);
      }
      return;
    }

    toastManager.add({
      type: "error",
      title: "Legacy pairing format is no longer supported.",
      description: "Create and use a relay connection string from Host this device.",
    });
  }, [desktopMode, hosts, importPayload, upsertHost]);

  const removeHost = useCallback(
    (host: RemoteHostInstance) => {
      const confirmed = window.confirm(`Remove "${host.name}" from saved remote hosts?`);
      if (!confirmed) {
        return;
      }
      saveHosts(hosts.filter((candidate) => candidate.id !== host.id));
    },
    [hosts, saveHosts],
  );

  const connectHost = useCallback(
    (host: RemoteHostInstance) => {
      const connectedAt = new Date().toISOString();
      saveHosts(
        hosts.map((candidate) =>
          candidate.id === host.id ? { ...candidate, lastConnectedAt: connectedAt } : candidate,
        ),
      );
      connectToWsHost(resolveHostConnectionWsUrl(host));
    },
    [hosts, saveHosts],
  );

  const connectLocalHost = useCallback(() => {
    connectToWsHost(localControlConnectionUrl);
  }, [localControlConnectionUrl]);

  const createRelayAccess = useCallback(async () => {
    setCreatingRelayDevice(true);
    try {
      const created = await createHostRelayDevice({
        wsUrl: localAdvertisedWsUrl,
        ...(localDeviceConnection.authToken ? { authToken: localDeviceConnection.authToken } : {}),
        ...(relayDraft.name.trim() ? { name: relayDraft.name.trim() } : {}),
        icon: relayDraft.icon,
      });
      setRelayHostToken(created.hostToken);
      setRelayResolveUrl(created.relayUrl);
      setRelayDraft(EMPTY_RELAY_DRAFT);
      setVisibleRelayQrDeviceId(created.devices[0]?.deviceId ?? null);
      toastManager.add({
        type: "success",
        title: "Remote device access created.",
      });
      await refreshRelayDevices();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not create remote access.",
        description: error instanceof Error ? error.message : "Relay device creation failed.",
      });
    } finally {
      setCreatingRelayDevice(false);
    }
  }, [
    localDeviceConnection.authToken,
    localAdvertisedWsUrl,
    refreshRelayDevices,
    relayDraft.icon,
    relayDraft.name,
  ]);

  const revokeRelayAccess = useCallback(
    async (device: RelayDeviceView) => {
      const confirmed = window.confirm(`Revoke access for "${device.name}"?`);
      if (!confirmed) {
        return;
      }
      setRevokingRelayDeviceId(device.deviceId);
      try {
        await revokeHostRelayDevice({
          wsUrl: localAdvertisedWsUrl,
          ...(localDeviceConnection.authToken
            ? { authToken: localDeviceConnection.authToken }
            : {}),
          deviceId: device.deviceId,
        });
        if (visibleRelayQrDeviceId === device.deviceId) {
          setVisibleRelayQrDeviceId(null);
        }
        toastManager.add({
          type: "success",
          title: "Remote access revoked.",
        });
        await refreshRelayDevices();
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not revoke remote access.",
          description: error instanceof Error ? error.message : "Relay revoke failed.",
        });
      } finally {
        setRevokingRelayDeviceId(null);
      }
    },
    [
      localDeviceConnection.authToken,
      localAdvertisedWsUrl,
      refreshRelayDevices,
      visibleRelayQrDeviceId,
    ],
  );

  const relayDevicesStatusRow = useMemo(() => {
    if (relayDeviceError) {
      return <SettingsRow title="Remote devices" description={relayDeviceError} />;
    }
    if (loadingRelayDevices && relayDevices.length === 0) {
      return <SettingsRow title="Remote devices" description="Loading relay devices…" />;
    }
    if (!loadingRelayDevices && relayDevices.length === 0) {
      return (
        <SettingsRow
          title="Remote devices"
          description="No remote device access keys yet. Add one above."
        />
      );
    }
    return null;
  }, [loadingRelayDevices, relayDeviceError, relayDevices.length]);

  return (
    <SettingsPageContainer>
      <SettingsSection title="Host this device" icon={<LaptopIcon className="size-3.5" />}>
        <SettingsRow
          title="Local ace host endpoint"
          description="Share this host with mobile/desktop clients. If clients are on other devices, bind your server to a LAN interface (for example 0.0.0.0)."
          status={
            <>
              <span className="block break-all font-mono text-[11px] text-foreground">
                {localAdvertisedWsUrl}
              </span>
              <span className="mt-1 block">
                {localDeviceConnection.authToken
                  ? "Host auth token is enabled."
                  : "No host auth token configured."}
              </span>
            </>
          }
          control={
            <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
              <Button
                size="xs"
                variant="outline"
                onClick={connectLocalHost}
                disabled={localIsActive}
              >
                {localIsActive ? "Active host" : "Use local host"}
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => copyToClipboard(localShareConnectionUrl, { label: "Host URL" })}
              >
                <LinkIcon className="size-3.5" />
                Copy URL
              </Button>
            </div>
          }
        />

        <SettingsRow
          title="Remote device access"
          description="Create named API-key access for remote devices. Each device gets a copyable connection string and optional QR."
          control={
            <Button
              size="xs"
              onClick={() => void createRelayAccess()}
              disabled={creatingRelayDevice}
            >
              {creatingRelayDevice ? "Creating…" : "Add remote device"}
            </Button>
          }
        >
          <div className="mt-3 grid gap-2">
            <Input
              value={relayDraft.name}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setRelayDraft((previous) => ({ ...previous, name: value }));
              }}
              placeholder="Remote device name (optional)"
            />
            <div className="flex flex-wrap gap-2">
              {RELAY_ICON_OPTIONS.map((option) => {
                const selected = relayDraft.icon === option.icon;
                return (
                  <Button
                    key={option.icon}
                    size="xs"
                    variant={selected ? "default" : "outline"}
                    onClick={() =>
                      setRelayDraft((previous) => ({ ...previous, icon: option.icon }))
                    }
                  >
                    <span>{option.label}</span>
                  </Button>
                );
              })}
            </div>
          </div>
        </SettingsRow>

        {relayDevicesStatusRow}

        {relayDevices.map((device) => {
          const revoked = device.revokedAt !== undefined;
          const isActive = device.activeConnectionCount > 0;
          const isShowingQr = visibleRelayQrDeviceId === device.deviceId;
          return (
            <SettingsRow
              key={device.deviceId}
              title={device.name}
              description={revoked ? "Access revoked" : isActive ? "Connected" : "Not connected"}
              status={
                <>
                  <span className="block">
                    Type: <span className="text-foreground">{relayIconLabel(device.icon)}</span>
                  </span>
                  <span className="block">
                    Created:{" "}
                    <span className="text-foreground">
                      {formatRelativeTimeLabel(device.createdAt)}
                    </span>
                  </span>
                  <span className="mt-1 block">
                    Last seen:{" "}
                    <span className="text-foreground">
                      {device.lastSeenAt ? formatRelativeTimeLabel(device.lastSeenAt) : "never"}
                    </span>
                  </span>
                  <span className="mt-1 block">
                    Active sessions:{" "}
                    <span className="text-foreground">{device.activeConnectionCount}</span>
                  </span>
                </>
              }
              control={
                <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      copyToClipboard(resolveRelayConnectionString(device), {
                        label: "Connection string",
                      })
                    }
                    disabled={revoked}
                  >
                    <LinkIcon className="size-3.5" />
                    Copy string
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setVisibleRelayQrDeviceId(isShowingQr ? null : device.deviceId)}
                    disabled={revoked}
                  >
                    {isShowingQr ? "Hide QR" : "Show QR"}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => void revokeRelayAccess(device)}
                    disabled={revoked || revokingRelayDeviceId === device.deviceId}
                  >
                    <Trash2Icon className="size-3.5" />
                    {revoked ? "Revoked" : "Revoke"}
                  </Button>
                </div>
              }
            >
              {isShowingQr ? (
                <div className="mt-3">
                  <div className="w-fit rounded-md border border-border/60 bg-background p-2">
                    {visibleRelayQrDataUrl ? (
                      <img
                        src={visibleRelayQrDataUrl}
                        alt="Relay connection QR code"
                        className="size-40 rounded-sm bg-white p-1"
                      />
                    ) : (
                      <div className="flex size-40 items-center justify-center text-[11px] text-muted-foreground">
                        Preparing QR…
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
            </SettingsRow>
          );
        })}
      </SettingsSection>

      <SettingsSection title="Remote control hosts" icon={<ScanLineIcon className="size-3.5" />}>
        <SettingsRow
          title="Add remote host"
          description={
            desktopMode
              ? "Save and switch between multiple remote hosts."
              : "URL mode allows one remote host at a time. Saving replaces the existing entry."
          }
          control={
            <Button size="xs" onClick={saveHostDraft}>
              Save host
            </Button>
          }
        >
          <div className="mt-3 grid gap-2">
            <Input
              value={hostDraft.name}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setHostDraft((previous) => ({ ...previous, name: value }));
              }}
              placeholder="Host name (optional)"
            />
            <Input
              value={hostDraft.wsUrl}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setHostDraft((previous) => ({ ...previous, wsUrl: value }));
              }}
              placeholder="ws://192.168.x.x:3773/ws"
            />
            <Input
              type="password"
              value={hostDraft.authToken}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setHostDraft((previous) => ({ ...previous, authToken: value }));
              }}
              placeholder="Auth token (optional)"
            />
          </div>
          <div className="mt-3 grid gap-2">
            <Textarea
              className="min-h-20 font-mono text-[11px] leading-relaxed"
              value={importPayload}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setImportPayload(value);
              }}
              placeholder="Paste relay connection string, ws/http URL, or host:port"
            />
            <div className="flex justify-end">
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  void importHostPayload();
                }}
                disabled={importingHost}
              >
                {importingHost ? "Connecting…" : "Import connection string"}
              </Button>
            </div>
          </div>
        </SettingsRow>

        {hosts.length === 0 ? (
          <SettingsRow
            title="Saved hosts"
            description={
              desktopMode
                ? "No remote hosts saved yet. Add one above to switch between hosts."
                : "No remote host saved yet. Add one above to connect from URL mode."
            }
          />
        ) : (
          hosts.map((host) => {
            const active = isHostConnectionActive(host, activeWsUrl);
            const connectionString = resolveHostConnectionWsUrl(host);
            return (
              <SettingsRow
                key={host.id}
                title={host.name}
                description={host.wsUrl}
                status={
                  <>
                    <span className="block">
                      {host.authToken.length > 0 ? "Auth token configured." : "No auth token."}
                    </span>
                    <span className="mt-1 block">
                      Last connected:{" "}
                      {host.lastConnectedAt
                        ? formatRelativeTimeLabel(host.lastConnectedAt)
                        : "never"}
                    </span>
                  </>
                }
                control={
                  <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => connectHost(host)}
                      disabled={active}
                    >
                      {active ? "Active host" : "Connect"}
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() =>
                        copyToClipboard(connectionString, { label: "Connection string" })
                      }
                    >
                      Copy string
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => removeHost(host)}>
                      <Trash2Icon className="size-3.5" />
                      Remove
                    </Button>
                  </div>
                }
              />
            );
          })
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
