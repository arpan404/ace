import {
  CheckCircle2Icon,
  CircleOffIcon,
  CopyIcon,
  LaptopIcon,
  QrCodeIcon,
  ScanLineIcon,
  ShieldAlertIcon,
  Trash2Icon,
} from "lucide-react";
import QRCode from "qrcode";
import { useCallback, useEffect, useMemo, useState } from "react";

import { isElectron } from "../../env";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  buildHostPairingConnectionString,
  connectToWsHost,
  createHostPairingSession,
  createRemoteHostInstance,
  isHostConnectionActive,
  loadRemoteHostInstances,
  parseHostConnectionQrPayload,
  persistRemoteHostInstances,
  readHostPairingAdvertisedEndpoint,
  resolveActiveWsUrl,
  resolveHostConnectionWsUrl,
  resolveLocalDeviceWsUrl,
  resolvePairingHostConnection,
  splitWsUrlAuthToken,
  type RemoteHostInstance,
  verifyWsHostConnection,
} from "../../lib/remoteHosts";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  PROJECT_ICON_COLOR_OPTIONS,
  PROJECT_ICON_OPTIONS,
  ProjectGlyphIcon,
} from "../ProjectAvatar";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

interface HostDraftState {
  readonly name: string;
  readonly connection: string;
  readonly authToken: string;
  readonly iconGlyph: "folder" | "terminal" | "code" | "flask" | "rocket" | "package";
  readonly iconColor: "slate" | "blue" | "violet" | "emerald" | "amber" | "rose";
}

interface PairingLinkState {
  readonly connectionString: string;
  readonly expiresAt: string;
  readonly qrDataUrl: string | null;
}

const EMPTY_HOST_DRAFT: HostDraftState = {
  name: "",
  connection: "",
  authToken: "",
  iconGlyph: "folder",
  iconColor: "slate",
};

const URL_MODE_MAX_HOSTS = 1;

function normalizeHostsForMode(hosts: ReadonlyArray<RemoteHostInstance>, desktopMode: boolean) {
  if (desktopMode) {
    return [...hosts];
  }
  return hosts.slice(0, URL_MODE_MAX_HOSTS);
}

function maskPairingLinkForDisplay(connectionString: string): string {
  try {
    const parsed = new URL(connectionString);
    if (parsed.protocol === "ace:" && parsed.searchParams.has("p")) {
      const encodedPayload = parsed.searchParams.get("p") ?? "";
      const maskedPayload =
        encodedPayload.length > 20
          ? `${encodedPayload.slice(0, 10)}…${encodedPayload.slice(-10)}`
          : "••••••••••";
      return `ace://pair?p=${maskedPayload}`;
    }
  } catch {
    // Fall through to generic truncation.
  }
  if (connectionString.length <= 64) {
    return connectionString;
  }
  return `${connectionString.slice(0, 40)}…${connectionString.slice(-20)}`;
}

export function DevicesSettingsPanel() {
  const desktopMode = isElectron;
  const [hosts, setHosts] = useState<RemoteHostInstance[]>(() =>
    normalizeHostsForMode(loadRemoteHostInstances(), desktopMode),
  );
  const [hostDraft, setHostDraft] = useState<HostDraftState>(EMPTY_HOST_DRAFT);
  const [importingHost, setImportingHost] = useState(false);
  const [advertisedLocalWsUrl, setAdvertisedLocalWsUrl] = useState<string | null>(null);
  const [refreshingLocalEndpoint, setRefreshingLocalEndpoint] = useState(false);
  const [pairingLink, setPairingLink] = useState<PairingLinkState | null>(null);
  const [creatingPairingLink, setCreatingPairingLink] = useState(false);
  const [hostAvailability, setHostAvailability] = useState<
    Record<string, "checking" | "available" | "unavailable" | "unauthenticated">
  >({});
  const [connectingHostId, setConnectingHostId] = useState<string | "local" | null>(null);
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

  const refreshLocalEndpoint = useCallback(async () => {
    setRefreshingLocalEndpoint(true);
    try {
      const endpoint = await readHostPairingAdvertisedEndpoint({
        wsUrl: localDeviceConnection.wsUrl,
        ...(localDeviceConnection.authToken ? { authToken: localDeviceConnection.authToken } : {}),
      });
      setAdvertisedLocalWsUrl(endpoint.wsUrl);
    } catch {
      setAdvertisedLocalWsUrl(null);
    } finally {
      setRefreshingLocalEndpoint(false);
    }
  }, [localDeviceConnection.authToken, localDeviceConnection.wsUrl]);

  useEffect(() => {
    void refreshLocalEndpoint();
  }, [refreshLocalEndpoint]);

  const upsertHost = useCallback(
    (draft: {
      readonly name?: string;
      readonly wsUrl: string;
      readonly authToken?: string;
      readonly iconGlyph?: "folder" | "terminal" | "code" | "flask" | "rocket" | "package";
      readonly iconColor?: "slate" | "blue" | "violet" | "emerald" | "amber" | "rose";
    }) => {
      const created = createRemoteHostInstance({
        wsUrl: draft.wsUrl,
        ...(draft.name?.trim() ? { name: draft.name } : {}),
        ...(draft.authToken?.trim() ? { authToken: draft.authToken } : {}),
        ...(draft.iconGlyph ? { iconGlyph: draft.iconGlyph } : {}),
        ...(draft.iconColor ? { iconColor: draft.iconColor } : {}),
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
        return;
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
    },
    [desktopMode, hosts, saveHosts],
  );

  const addRemoteHost = useCallback(async () => {
    const parsed = parseHostConnectionQrPayload(hostDraft.connection);
    if (!parsed) {
      toastManager.add({
        type: "error",
        title: "Invalid connection input.",
        description: "Use a pairing link (ace://...) or a ws/http host URL.",
      });
      return;
    }

    setImportingHost(true);
    try {
      const resolvedDraft =
        parsed.kind === "pairing"
          ? await resolvePairingHostConnection(parsed.pairing, {
              requesterName: desktopMode ? "ace desktop" : "ace web",
            })
          : parsed.draft;

      const authToken = hostDraft.authToken.trim() || resolvedDraft.authToken;
      upsertHost({
        name: hostDraft.name.trim() || resolvedDraft.name || "",
        wsUrl: resolvedDraft.wsUrl,
        ...(authToken ? { authToken } : {}),
        iconGlyph: hostDraft.iconGlyph,
        iconColor: hostDraft.iconColor,
      });
      setHostDraft(EMPTY_HOST_DRAFT);
      toastManager.add({
        type: "success",
        title: "Remote host added.",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not add remote host.",
        description: error instanceof Error ? error.message : "Remote host setup failed.",
      });
    } finally {
      setImportingHost(false);
    }
  }, [desktopMode, hostDraft, upsertHost]);

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
    async (host: RemoteHostInstance) => {
      if (connectingHostId !== null) {
        return;
      }
      setConnectingHostId(host.id);
      try {
        await verifyWsHostConnection(resolveHostConnectionWsUrl(host));
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not connect to host.",
          description:
            error instanceof Error ? error.message : "Host connection check did not complete.",
        });
        setConnectingHostId(null);
        return;
      }
      const connectedAt = new Date().toISOString();
      saveHosts(
        hosts.map((candidate) =>
          candidate.id === host.id ? { ...candidate, lastConnectedAt: connectedAt } : candidate,
        ),
      );
      connectToWsHost(resolveHostConnectionWsUrl(host));
    },
    [connectingHostId, hosts, saveHosts],
  );

  const connectLocalHost = useCallback(async () => {
    if (connectingHostId !== null) {
      return;
    }
    setConnectingHostId("local");
    try {
      await verifyWsHostConnection(localControlConnectionUrl);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not connect to local host.",
        description:
          error instanceof Error ? error.message : "Local host connection check did not complete.",
      });
      setConnectingHostId(null);
      return;
    }
    connectToWsHost(localControlConnectionUrl);
  }, [connectingHostId, localControlConnectionUrl]);

  const createPairingLink = useCallback(async () => {
    setCreatingPairingLink(true);
    try {
      const created = await createHostPairingSession({
        wsUrl: localAdvertisedWsUrl,
        ...(localDeviceConnection.authToken ? { authToken: localDeviceConnection.authToken } : {}),
      });
      const connectionString = buildHostPairingConnectionString({
        sessionId: created.sessionId,
        secret: created.secret,
        claimUrl: created.claimUrl,
      });
      const qrDataUrl = await QRCode.toDataURL(connectionString, {
        margin: 1,
        width: 220,
      });
      setPairingLink({
        connectionString,
        expiresAt: created.expiresAt,
        qrDataUrl,
      });
      toastManager.add({
        type: "success",
        title: "Pairing link created.",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not create pairing link.",
        description: error instanceof Error ? error.message : "Pairing link creation failed.",
      });
    } finally {
      setCreatingPairingLink(false);
    }
  }, [localAdvertisedWsUrl, localDeviceConnection.authToken]);

  const refreshHostAvailability = useCallback(async () => {
    if (hosts.length === 0) {
      return;
    }
    await Promise.all(
      hosts.map(async (host) => {
        setHostAvailability((current) => ({ ...current, [host.id]: "checking" }));
        try {
          await readHostPairingAdvertisedEndpoint({
            wsUrl: host.wsUrl,
            ...(host.authToken ? { authToken: host.authToken } : {}),
          });
          setHostAvailability((current) => ({ ...current, [host.id]: "available" }));
        } catch (error) {
          const message = error instanceof Error ? error.message.toLowerCase() : "";
          const unauthenticated =
            message.includes("invalid") ||
            message.includes("unauthorized") ||
            message.includes("401");
          setHostAvailability((current) => ({
            ...current,
            [host.id]: unauthenticated ? "unauthenticated" : "unavailable",
          }));
        }
      }),
    );
  }, [hosts]);

  useEffect(() => {
    void refreshHostAvailability();
    const handle = window.setInterval(() => {
      void refreshHostAvailability();
    }, 8_000);
    return () => window.clearInterval(handle);
  }, [refreshHostAvailability]);

  return (
    <SettingsPageContainer>
      <SettingsSection title="Host this device" icon={<LaptopIcon className="size-3.5" />}>
        <SettingsRow
          title="Local ace host endpoint"
          description="Share this host with mobile/desktop clients. For other devices, bind your server to a LAN or tailnet interface."
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
                onClick={() => void refreshLocalEndpoint()}
                disabled={refreshingLocalEndpoint}
              >
                {refreshingLocalEndpoint ? "Refreshing…" : "Refresh"}
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => void connectLocalHost()}
                disabled={localIsActive || connectingHostId !== null}
              >
                {localIsActive
                  ? "Active host"
                  : connectingHostId === "local"
                    ? "Checking…"
                    : "Use local host"}
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => copyToClipboard(localShareConnectionUrl, { label: "Host URL" })}
              >
                <CopyIcon className="size-3.5" />
                Copy URL
              </Button>
            </div>
          }
        />

        <SettingsRow
          title="Pairing link"
          description="Create a one-time pairing link for another device. Pairing links expire automatically."
          control={
            <Button
              size="xs"
              onClick={() => void createPairingLink()}
              disabled={creatingPairingLink}
            >
              {creatingPairingLink ? "Creating…" : "Create Link"}
            </Button>
          }
        >
          {pairingLink ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <code className="max-w-full break-all rounded bg-muted px-2 py-1 text-[10px]">
                {maskPairingLinkForDisplay(pairingLink.connectionString)}
              </code>
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  copyToClipboard(pairingLink.connectionString, {
                    label: "Pairing link",
                  })
                }
              >
                <CopyIcon className="size-3.5" />
                Copy link
              </Button>
              <Popover>
                <PopoverTrigger className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
                  <QrCodeIcon className="size-3.5" />
                  QR
                </PopoverTrigger>
                <PopoverPopup side="bottom" align="end" className="w-fit p-2">
                  <div className="w-fit rounded-md border border-border/60 bg-background p-2">
                    {pairingLink.qrDataUrl ? (
                      <img
                        src={pairingLink.qrDataUrl}
                        alt="Pairing link QR code"
                        className="size-40 rounded-sm bg-white p-1"
                      />
                    ) : null}
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      Expires {formatRelativeTimeLabel(pairingLink.expiresAt)}
                    </div>
                  </div>
                </PopoverPopup>
              </Popover>
            </div>
          ) : null}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Remote control hosts" icon={<ScanLineIcon className="size-3.5" />}>
        <SettingsRow
          title="Add remote host"
          description={
            desktopMode
              ? "Paste a pairing link (recommended), or enter a host URL and token manually."
              : "URL mode allows one remote host at a time. New host replaces the existing entry."
          }
          control={
            <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
              <Button size="xs" variant="outline" onClick={() => void refreshHostAvailability()}>
                Refresh status
              </Button>
              <Button size="xs" onClick={() => void addRemoteHost()} disabled={importingHost}>
                {importingHost ? "Adding…" : "Add host"}
              </Button>
            </div>
          }
        >
          <div className="mt-3 grid gap-2">
            <Input
              value={hostDraft.name}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setHostDraft((previous) => ({ ...previous, name: value }));
              }}
              placeholder="Device name"
            />
            <Input
              value={hostDraft.connection}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setHostDraft((previous) => ({ ...previous, connection: value }));
              }}
              placeholder="ace://pair?... or ws://host:3773/ws"
            />
            <Input
              value={hostDraft.authToken}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setHostDraft((previous) => ({ ...previous, authToken: value }));
              }}
              placeholder="Optional auth token for direct host URL"
            />
            <div className="rounded-md border border-border/60 p-2">
              <div className="mb-2 text-[11px] text-muted-foreground">Device icon</div>
              <div className="mb-2 flex flex-wrap gap-1.5">
                {PROJECT_ICON_OPTIONS.map((option) => {
                  const selected = hostDraft.iconGlyph === option.glyph;
                  return (
                    <button
                      key={option.glyph}
                      type="button"
                      className={`inline-flex size-8 items-center justify-center rounded border ${
                        selected
                          ? "border-primary/60 bg-primary/10"
                          : "border-border hover:bg-accent"
                      }`}
                      onClick={() =>
                        setHostDraft((previous) => ({ ...previous, iconGlyph: option.glyph }))
                      }
                      title={option.label}
                      aria-label={option.label}
                    >
                      <ProjectGlyphIcon
                        icon={{
                          glyph: option.glyph,
                          color: hostDraft.iconColor,
                        }}
                        className="size-4"
                      />
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {PROJECT_ICON_COLOR_OPTIONS.map((option) => {
                  const selected = hostDraft.iconColor === option.color;
                  return (
                    <button
                      key={option.color}
                      type="button"
                      className={`inline-flex h-7 items-center gap-1 rounded border px-2 text-[11px] ${
                        selected
                          ? "border-primary/60 bg-primary/10"
                          : "border-border hover:bg-accent"
                      }`}
                      onClick={() =>
                        setHostDraft((previous) => ({ ...previous, iconColor: option.color }))
                      }
                    >
                      <span className={`size-2 rounded-full ${option.swatchClassName}`} />
                      {option.label}
                    </button>
                  );
                })}
              </div>
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
                      {hostAvailability[host.id] === "available" ? (
                        <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-300">
                          <CheckCircle2Icon className="size-3.5" />
                          Available
                        </span>
                      ) : hostAvailability[host.id] === "unauthenticated" ? (
                        <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-300">
                          <ShieldAlertIcon className="size-3.5" />
                          Unauthenticated
                        </span>
                      ) : hostAvailability[host.id] === "checking" ? (
                        "Checking availability…"
                      ) : (
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          <CircleOffIcon className="size-3.5" />
                          Unavailable
                        </span>
                      )}
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
                    <span className="inline-flex items-center">
                      <ProjectGlyphIcon
                        icon={{
                          glyph: host.iconGlyph ?? "folder",
                          color: host.iconColor ?? "slate",
                        }}
                        className="size-4"
                      />
                    </span>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => void connectHost(host)}
                      disabled={active || connectingHostId !== null}
                    >
                      {active
                        ? "Active host"
                        : connectingHostId === host.id
                          ? "Checking…"
                          : "Connect"}
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
