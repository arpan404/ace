import {
  CheckCircle2Icon,
  CircleOffIcon,
  CopyIcon,
  LaptopIcon,
  QrCodeIcon,
  ScanLineIcon,
  ShieldAlertIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { DEFAULT_MANAGED_RELAY_URL } from "@ace/contracts";
import { describeHostConnection } from "@ace/shared/hostConnections";
import QRCode from "qrcode";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { validateRelayWebSocketUrl } from "@ace/shared/relay";

import { isElectron } from "../../env";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import {
  subscribeToDesktopPairingLinks,
  takePendingDesktopPairingLink,
} from "../../lib/desktopPairingLinks";
import { ensureNativeApi } from "../../nativeApi";
import {
  buildHostPairingConnectionString,
  createHostPairingSession,
  createRemoteHostInstance,
  loadConnectedRemoteHostIds,
  listHostPairingSessions,
  loadRemoteHostInstances,
  parseHostConnectionQrPayload,
  persistConnectedRemoteHostIds,
  persistRemoteHostInstances,
  readHostPairingAdvertisedEndpoint,
  readHostPairingSession,
  revokeHostPairingSession,
  resolveHostConnectionWsUrl,
  resolveLocalDeviceWsUrl,
  resolvePairingHostConnection,
  splitWsUrlAuthToken,
  type HostPairingSessionSummary,
  type HostPairingSessionStatus,
  type RemoteHostInstance,
  verifyWsHostConnection,
} from "../../lib/remoteHosts";
import {
  disposeRemoteRouteClient,
  probeRemoteRouteAvailability,
  registerRemoteRoute,
  unregisterRemoteRoute,
} from "../../lib/remoteWsRouter";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useHostConnectionStore } from "../../hostConnectionStore";
import { useServerConfig } from "../../rpc/serverState";
import { useStore } from "../../store";
import {
  PROJECT_ICON_COLOR_OPTIONS,
  PROJECT_ICON_OPTIONS,
  ProjectGlyphIcon,
} from "../ProjectAvatar";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer } from "./SettingsPanelPrimitives";

const SETTINGS_INLINE_PANEL_CLASS_NAME =
  "rounded-[var(--control-radius)] border border-pill-border/58 bg-background/56 shadow-none";
const SETTINGS_INLINE_PANEL_MUTED_CLASS_NAME =
  "rounded-[var(--control-radius)] border border-pill-border/48 bg-background/36 shadow-none";
const SETTINGS_POPOVER_TRIGGER_CLASS_NAME =
  "inline-flex h-7 items-center gap-1 rounded-[var(--control-radius)] border border-pill-border/58 bg-background/56 px-2 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30";
const SETTINGS_NATIVE_SELECT_CLASS_NAME =
  "h-7 rounded-[var(--control-radius)] border border-pill-border/58 bg-background/56 px-2 text-[12px] text-foreground outline-none transition-[border-color,background-color,box-shadow] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30";
const DEVICE_SECTION_CLASS_NAME =
  "overflow-hidden rounded-[var(--panel-radius)] border border-pill-border/58 bg-pill/58 text-card-foreground supports-[backdrop-filter]:bg-pill/48 supports-[backdrop-filter]:backdrop-blur-lg";
const DEVICE_SUBPANEL_CLASS_NAME =
  "rounded-[var(--control-radius)] border border-pill-border/52 bg-background/42";
const DEVICE_ACTION_GROUP_CLASS_NAME = "flex flex-wrap items-center gap-2";
const DEVICE_META_TEXT_CLASS_NAME = "text-[11px] leading-relaxed text-muted-foreground/62";

interface HostDraftState {
  readonly name: string;
  readonly connection: string;
  readonly iconGlyph: RemoteHostInstance["iconGlyph"];
  readonly iconColor: RemoteHostInstance["iconColor"];
}

interface PairingLinkState {
  readonly sessionId: string;
  readonly connectionString: string;
  readonly expiresAt: string;
  readonly qrDataUrl: string | null;
}

const EMPTY_HOST_DRAFT: HostDraftState = {
  name: "",
  connection: "",
  iconGlyph: "folder",
  iconColor: "slate",
};

const URL_MODE_MAX_HOSTS = 1;

function DeviceSection({
  title,
  description,
  icon,
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  icon: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 space-y-1.5">
      <div className="flex min-w-0 flex-col gap-2 px-0.5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-0.5">
          <h2 className="flex min-w-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/62">
            <span className="shrink-0 text-muted-foreground/65">{icon}</span>
            <span className="min-w-0 truncate">{title}</span>
          </h2>
          {description ? (
            <p className="max-w-3xl text-[11px] leading-relaxed text-muted-foreground/52">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? <div className={DEVICE_ACTION_GROUP_CLASS_NAME}>{actions}</div> : null}
      </div>
      <div className={DEVICE_SECTION_CLASS_NAME}>{children}</div>
    </section>
  );
}

function DeviceSubPanel({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn(DEVICE_SUBPANEL_CLASS_NAME, className)}>
      <div className="flex min-w-0 flex-col gap-2 border-b border-pill-border/42 px-3 py-2.5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-0.5">
          <h3 className="text-[13px] leading-snug font-medium text-foreground/88">{title}</h3>
          {description ? <p className={DEVICE_META_TEXT_CLASS_NAME}>{description}</p> : null}
        </div>
        {actions ? <div className={DEVICE_ACTION_GROUP_CLASS_NAME}>{actions}</div> : null}
      </div>
      <div className="min-w-0 p-3">{children}</div>
    </div>
  );
}

function DeviceStatusBadge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 w-fit max-w-full shrink-0 items-center gap-1 self-start rounded-[var(--control-radius)] border px-1.5 text-[10px] font-medium",
        tone === "neutral" && "border-pill-border/52 bg-background/42 text-muted-foreground",
        tone === "info" && "border-primary/30 bg-primary/10 text-info-foreground",
        tone === "success" && "border-success/30 bg-success/10 text-success-foreground",
        tone === "warning" && "border-warning/35 bg-warning/10 text-warning-foreground",
        tone === "danger" && "border-destructive/35 bg-destructive/10 text-destructive-foreground",
      )}
    >
      {children}
    </span>
  );
}

function normalizeHostsForMode(hosts: ReadonlyArray<RemoteHostInstance>, desktopMode: boolean) {
  if (desktopMode) {
    return [...hosts];
  }
  return hosts.slice(0, URL_MODE_MAX_HOSTS);
}

function maskPairingLinkForDisplay(connectionString: string): string {
  if (connectionString.length <= 80) {
    return connectionString;
  }
  return `${connectionString.slice(0, 50)}…${connectionString.slice(-25)}`;
}

function resolveAvailabilityPollDelayMs(): number {
  return Math.floor(4_990 + Math.random() * 5_010);
}

export function DevicesSettingsPanel() {
  const desktopMode = isElectron;
  const remoteRelaySettings = useSettings((settings) => settings.remoteRelay);
  const serverConfig = useServerConfig();
  const { updateSettings } = useUpdateSettings();
  const [hosts, setHosts] = useState<RemoteHostInstance[]>(() =>
    normalizeHostsForMode(loadRemoteHostInstances(), desktopMode),
  );
  const [connectedHostIds, setConnectedHostIds] = useState<string[]>(() =>
    loadConnectedRemoteHostIds(),
  );
  const [hostDraft, setHostDraft] = useState<HostDraftState>(EMPTY_HOST_DRAFT);
  const [editingHostId, setEditingHostId] = useState<string | null>(null);
  const [importingHost, setImportingHost] = useState(false);
  const [advertisedLocalWsUrl, setAdvertisedLocalWsUrl] = useState<string | null>(null);
  const [refreshingLocalEndpoint, setRefreshingLocalEndpoint] = useState(false);
  const [pairingLabel, setPairingLabel] = useState("");
  const [relayUrlDraft, setRelayUrlDraft] = useState(remoteRelaySettings.defaultUrl);
  const [pairingLink, setPairingLink] = useState<PairingLinkState | null>(null);
  const [creatingPairingLink, setCreatingPairingLink] = useState(false);
  const [revokingPairingLink, setRevokingPairingLink] = useState(false);
  const [pairingSessionStatus, setPairingSessionStatus] = useState<HostPairingSessionStatus | null>(
    null,
  );
  const [pendingDesktopPairingSignal, setPendingDesktopPairingSignal] = useState(0);
  const [pairedSessions, setPairedSessions] = useState<ReadonlyArray<HostPairingSessionSummary>>(
    [],
  );
  const [refreshingPairedSessions, setRefreshingPairedSessions] = useState(false);
  const [revokingPairedSessionIds, setRevokingPairedSessionIds] = useState<Record<string, boolean>>(
    {},
  );
  const [hostAvailability, setHostAvailability] = useState<
    Record<
      string,
      { status: "checking" | "available" | "unavailable" | "unauthenticated"; requestId: number }
    >
  >({});
  const [checkingHostId, setCheckingHostId] = useState<string | null>(null);
  const [connectingHostId, setConnectingHostId] = useState<string | "local" | null>(null);
  const registeredRouteConnectionUrlsRef = useRef<Set<string>>(new Set());
  const localDeviceConnection = useMemo(() => splitWsUrlAuthToken(resolveLocalDeviceWsUrl()), []);
  useEffect(() => {
    setRelayUrlDraft(remoteRelaySettings.defaultUrl);
  }, [remoteRelaySettings.defaultUrl]);
  const localControlConnectionUrl = useMemo(
    () =>
      resolveHostConnectionWsUrl({
        wsUrl: localDeviceConnection.wsUrl,
        authToken: localDeviceConnection.authToken,
      }),
    [localDeviceConnection.authToken, localDeviceConnection.wsUrl],
  );
  const localAdvertisedWsUrl = advertisedLocalWsUrl ?? localDeviceConnection.wsUrl;
  const localShareConnectionUrl = useMemo(
    () =>
      resolveHostConnectionWsUrl({
        wsUrl: localAdvertisedWsUrl,
        authToken: localDeviceConnection.authToken,
      }),
    [localAdvertisedWsUrl, localDeviceConnection.authToken],
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

  const saveConnectedHostIds = useCallback((nextConnectedHostIds: ReadonlyArray<string>) => {
    const deduped = [...new Set(nextConnectedHostIds.filter((hostId) => hostId.trim().length > 0))];
    setConnectedHostIds(deduped);
    persistConnectedRemoteHostIds(deduped);
  }, []);

  const clearHostDraft = useCallback(() => {
    setHostDraft(EMPTY_HOST_DRAFT);
    setEditingHostId(null);
  }, []);

  const sortedHosts = useMemo(() => {
    const connectedIds = new Set(connectedHostIds);
    return [...hosts].toSorted((left, right) => {
      const leftConnected = connectedIds.has(left.id) ? 1 : 0;
      const rightConnected = connectedIds.has(right.id) ? 1 : 0;
      if (leftConnected !== rightConnected) {
        return rightConnected - leftConnected;
      }
      const leftLastConnectedAt = Date.parse(left.lastConnectedAt ?? "") || 0;
      const rightLastConnectedAt = Date.parse(right.lastConnectedAt ?? "") || 0;
      if (leftLastConnectedAt !== rightLastConnectedAt) {
        return rightLastConnectedAt - leftLastConnectedAt;
      }
      return left.name.localeCompare(right.name);
    });
  }, [hosts, connectedHostIds]);

  const pinnedRelayUrls = useMemo(
    () => Array.from(new Set(pairedSessions.map((session) => session.relayUrl).filter(Boolean))),
    [pairedSessions],
  );
  const relayRegistrations = serverConfig?.relay?.registrations ?? [];
  const hasPinnedRelayMismatch = pinnedRelayUrls.some(
    (relayUrl) => relayUrl !== remoteRelaySettings.defaultUrl,
  );

  useEffect(() => {
    const availableHostIds = new Set(hosts.map((host) => host.id));
    const nextConnectedHostIds = connectedHostIds.filter((hostId) => availableHostIds.has(hostId));
    if (nextConnectedHostIds.length !== connectedHostIds.length) {
      saveConnectedHostIds(nextConnectedHostIds);
    }
  }, [hosts, connectedHostIds, saveConnectedHostIds]);

  useEffect(() => {
    const nextConnectionUrls = new Set(
      hosts
        .filter((host) => connectedHostIds.includes(host.id))
        .map((host) => resolveHostConnectionWsUrl(host)),
    );
    const previousConnectionUrls = registeredRouteConnectionUrlsRef.current;

    for (const connectionUrl of nextConnectionUrls) {
      if (previousConnectionUrls.has(connectionUrl)) {
        continue;
      }
      registerRemoteRoute(connectionUrl);
    }
    for (const connectionUrl of previousConnectionUrls) {
      if (nextConnectionUrls.has(connectionUrl)) {
        continue;
      }
      unregisterRemoteRoute(connectionUrl);
    }

    registeredRouteConnectionUrlsRef.current = nextConnectionUrls;
  }, [hosts, connectedHostIds]);

  useEffect(
    () => () => {
      for (const connectionUrl of registeredRouteConnectionUrlsRef.current) {
        unregisterRemoteRoute(connectionUrl);
      }
      registeredRouteConnectionUrlsRef.current.clear();
    },
    [],
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

  const saveRelaySettings = useCallback(() => {
    try {
      const normalized = validateRelayWebSocketUrl(relayUrlDraft, {
        allowInsecureLocalUrls: remoteRelaySettings.allowInsecureLocalUrls,
      });
      updateSettings({
        remoteRelay: {
          enabled: remoteRelaySettings.enabled,
          defaultUrl: normalized,
          allowInsecureLocalUrls: remoteRelaySettings.allowInsecureLocalUrls,
        },
      });
      setRelayUrlDraft(normalized);
      toastManager.add({
        type: "success",
        title: "Default relay updated.",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Invalid relay URL.",
        description: error instanceof Error ? error.message : "Relay URL validation failed.",
      });
    }
  }, [
    relayUrlDraft,
    remoteRelaySettings.allowInsecureLocalUrls,
    remoteRelaySettings.enabled,
    updateSettings,
  ]);

  const toggleInsecureRelayUrls = useCallback(
    (allow: boolean) => {
      updateSettings({
        remoteRelay: {
          enabled: remoteRelaySettings.enabled,
          defaultUrl: relayUrlDraft,
          allowInsecureLocalUrls: allow,
        },
      });
    },
    [relayUrlDraft, remoteRelaySettings.enabled, updateSettings],
  );

  const toggleRemoteRelayEnabled = useCallback(
    (enabled: boolean) => {
      updateSettings({
        remoteRelay: {
          enabled,
          defaultUrl: relayUrlDraft,
          allowInsecureLocalUrls: remoteRelaySettings.allowInsecureLocalUrls,
        },
      });
    },
    [relayUrlDraft, remoteRelaySettings.allowInsecureLocalUrls, updateSettings],
  );

  const markHostLastConnected = useCallback(
    (hostId: string) => {
      const nowIso = new Date().toISOString();
      saveHosts(
        hosts.map((candidate) =>
          candidate.id === hostId ? { ...candidate, lastConnectedAt: nowIso } : candidate,
        ),
      );
    },
    [hosts, saveHosts],
  );

  useEffect(() => {
    void refreshLocalEndpoint();
  }, [refreshLocalEndpoint]);

  useEffect(() => {
    if (!desktopMode) {
      return;
    }

    const handlePendingPairingLink = () => {
      setPendingDesktopPairingSignal((current) => current + 1);
    };

    handlePendingPairingLink();
    return subscribeToDesktopPairingLinks(handlePendingPairingLink);
  }, [desktopMode]);

  const upsertHost = useCallback(
    (
      draft: {
        readonly name?: string;
        readonly wsUrl: string;
        readonly authToken?: string;
        readonly iconGlyph?: RemoteHostInstance["iconGlyph"];
        readonly iconColor?: RemoteHostInstance["iconColor"];
      },
      existingHostId?: string,
    ): RemoteHostInstance => {
      const existingHost = existingHostId
        ? hosts.find((candidate) => candidate.id === existingHostId)
        : undefined;
      const created = createRemoteHostInstance(
        {
          wsUrl: draft.wsUrl,
          ...(draft.name?.trim() ? { name: draft.name } : {}),
          ...(draft.authToken?.trim() ? { authToken: draft.authToken } : {}),
          ...(draft.iconGlyph ? { iconGlyph: draft.iconGlyph } : {}),
          ...(draft.iconColor ? { iconColor: draft.iconColor } : {}),
        },
        existingHost,
      );

      if (!desktopMode) {
        const existing = existingHost ?? hosts[0];
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
        return replacedHost;
      }

      if (existingHost) {
        const nextHosts = hosts.map((candidate) =>
          candidate.id === existingHost.id ? created : candidate,
        );
        saveHosts(nextHosts);
        return created;
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
      return duplicate === undefined
        ? created
        : {
            ...created,
            id: duplicate.id,
            createdAt: duplicate.createdAt,
            ...(duplicate.lastConnectedAt ? { lastConnectedAt: duplicate.lastConnectedAt } : {}),
          };
    },
    [desktopMode, hosts, saveHosts],
  );

  const importRemoteHostConnection = useCallback(
    async (
      connectionInput: string,
      options?: {
        readonly existingHostId?: string;
        readonly overrideName?: string;
        readonly iconGlyph?: RemoteHostInstance["iconGlyph"];
        readonly iconColor?: RemoteHostInstance["iconColor"];
        readonly requesterName?: string;
      },
    ): Promise<RemoteHostInstance> => {
      const parsed = parseHostConnectionQrPayload(connectionInput);
      if (!parsed) {
        throw new Error("Use a pairing link (ace://...) or a ws/http host URL.");
      }

      const resolvedDraft =
        parsed.kind === "pairing"
          ? await resolvePairingHostConnection(parsed.pairing, {
              requesterName: options?.requesterName ?? (desktopMode ? "ace desktop" : "ace web"),
            })
          : parsed.draft;

      const upsertedHost = upsertHost(
        {
          name: options?.overrideName?.trim() || resolvedDraft.name || "",
          wsUrl: resolvedDraft.wsUrl,
          ...(resolvedDraft.authToken ? { authToken: resolvedDraft.authToken } : {}),
          ...(options?.iconGlyph ? { iconGlyph: options.iconGlyph } : {}),
          ...(options?.iconColor ? { iconColor: options.iconColor } : {}),
        },
        options?.existingHostId,
      );

      try {
        await verifyWsHostConnection(resolveHostConnectionWsUrl(upsertedHost), {
          timeoutMs: 2_500,
        });
        setHostAvailability((current) => ({
          ...current,
          [upsertedHost.id]: { status: "available", requestId: Date.now() },
        }));
      } catch (error) {
        setHostAvailability((current) => ({
          ...current,
          [upsertedHost.id]: { status: "unavailable", requestId: Date.now() },
        }));
        toastManager.add({
          type: "warning",
          title: "Host saved but currently unavailable.",
          description:
            error instanceof Error ? error.message : "Could not reach this host right now.",
        });
      }

      return upsertedHost;
    },
    [desktopMode, upsertHost],
  );

  const addRemoteHost = useCallback(async () => {
    setImportingHost(true);
    try {
      const editingHost = editingHostId
        ? hosts.find((host) => host.id === editingHostId)
        : undefined;
      await importRemoteHostConnection(hostDraft.connection, {
        overrideName: hostDraft.name,
        ...(editingHost?.id ? { existingHostId: editingHost.id } : {}),
        ...(hostDraft.iconGlyph ? { iconGlyph: hostDraft.iconGlyph } : {}),
        ...(hostDraft.iconColor ? { iconColor: hostDraft.iconColor } : {}),
      });
      clearHostDraft();
      toastManager.add({
        type: "success",
        title: editingHost ? "Remote host updated." : "Remote host added.",
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
  }, [
    clearHostDraft,
    editingHostId,
    hostDraft.connection,
    hostDraft.iconColor,
    hostDraft.iconGlyph,
    hostDraft.name,
    hosts,
    importRemoteHostConnection,
  ]);

  useEffect(() => {
    if (!desktopMode || importingHost) {
      return;
    }

    const pendingPairingLink = takePendingDesktopPairingLink();
    if (!pendingPairingLink) {
      return;
    }

    let active = true;
    setImportingHost(true);
    void importRemoteHostConnection(pendingPairingLink, {
      requesterName: "ace desktop",
    })
      .then(() => {
        if (!active) {
          return;
        }
        toastManager.add({
          type: "success",
          title: "Pairing link imported.",
        });
      })
      .catch((error) => {
        if (!active) {
          return;
        }
        toastManager.add({
          type: "error",
          title: "Could not import pairing link.",
          description: error instanceof Error ? error.message : "Pairing link import failed.",
        });
      })
      .finally(() => {
        if (active) {
          setImportingHost(false);
        }
      });

    return () => {
      active = false;
    };
  }, [desktopMode, importRemoteHostConnection, importingHost, pendingDesktopPairingSignal]);

  const startEditingHost = useCallback((host: RemoteHostInstance) => {
    setEditingHostId(host.id);
    setHostDraft({
      name: host.name,
      connection: resolveHostConnectionWsUrl(host),
      iconGlyph: host.iconGlyph ?? "folder",
      iconColor: host.iconColor ?? "slate",
    });
  }, []);

  const removeHost = useCallback(
    async (host: RemoteHostInstance) => {
      const confirmed = await ensureNativeApi().dialogs.confirm(
        `Remove "${host.name}" from saved remote hosts?`,
      );
      if (!confirmed) {
        return;
      }
      saveConnectedHostIds(connectedHostIds.filter((hostId) => hostId !== host.id));
      saveHosts(hosts.filter((candidate) => candidate.id !== host.id));
      if (editingHostId === host.id) {
        clearHostDraft();
      }
      try {
        await disposeRemoteRouteClient(resolveHostConnectionWsUrl(host));
      } catch (error) {
        toastManager.add({
          type: "warning",
          title: "Removed host, but cleanup failed.",
          description:
            error instanceof Error ? error.message : "Remote route cleanup did not complete.",
        });
      }
    },
    [clearHostDraft, connectedHostIds, editingHostId, hosts, saveConnectedHostIds, saveHosts],
  );

  const checkHostAvailability = useCallback(
    async (host: RemoteHostInstance) => {
      if (checkingHostId !== null) {
        return;
      }
      setCheckingHostId(host.id);
      try {
        await verifyWsHostConnection(resolveHostConnectionWsUrl(host), {
          timeoutMs: 2_500,
        });
        setHostAvailability((current) => ({
          ...current,
          [host.id]: { status: "available", requestId: Date.now() },
        }));
      } catch (error) {
        setHostAvailability((current) => ({
          ...current,
          [host.id]: { status: "unavailable", requestId: Date.now() },
        }));
        toastManager.add({
          type: "error",
          title: "Host is unavailable.",
          description:
            error instanceof Error ? error.message : "Host connection check did not complete.",
        });
      } finally {
        setCheckingHostId(null);
      }
    },
    [checkingHostId],
  );

  const connectHost = useCallback(
    async (host: RemoteHostInstance) => {
      if (connectingHostId !== null || connectedHostIds.includes(host.id)) {
        return;
      }
      const connectionString = resolveHostConnectionWsUrl(host);
      setConnectingHostId(host.id);
      try {
        await verifyWsHostConnection(connectionString, {
          timeoutMs: 2_500,
        });
        setHostAvailability((current) => ({
          ...current,
          [host.id]: { status: "available", requestId: Date.now() },
        }));
        markHostLastConnected(host.id);
        registerRemoteRoute(connectionString);
        await probeRemoteRouteAvailability(connectionString, {
          force: true,
          timeoutMs: 2_500,
        });
        saveConnectedHostIds([...connectedHostIds, host.id]);
        toastManager.add({
          type: "success",
          title: `Connected to ${host.name}`,
          description: "Local host remains the primary server.",
        });
      } catch (error) {
        setHostAvailability((current) => ({
          ...current,
          [host.id]: { status: "unavailable", requestId: Date.now() },
        }));
        toastManager.add({
          type: "error",
          title: "Could not connect to remote host.",
          description:
            error instanceof Error ? error.message : "Host connection check did not complete.",
        });
      } finally {
        setConnectingHostId(null);
      }
    },
    [connectedHostIds, connectingHostId, markHostLastConnected, saveConnectedHostIds],
  );

  const disconnectHost = useCallback(
    async (host: RemoteHostInstance) => {
      if (connectingHostId !== null || !connectedHostIds.includes(host.id)) {
        return;
      }
      setConnectingHostId(host.id);
      try {
        saveConnectedHostIds(
          connectedHostIds.filter((candidateHostId) => candidateHostId !== host.id),
        );
        const connectionUrl = resolveHostConnectionWsUrl(host);
        await disposeRemoteRouteClient(connectionUrl);
        const ownership = useHostConnectionStore.getState().getOwnership(connectionUrl);
        if (ownership) {
          useStore.getState().removeReadModelEntities(ownership);
        }
        useHostConnectionStore.getState().removeConnection(connectionUrl);
      } catch (error) {
        toastManager.add({
          type: "warning",
          title: "Disconnected host, but cleanup failed.",
          description:
            error instanceof Error ? error.message : "Remote route cleanup did not complete.",
        });
      } finally {
        setConnectingHostId(null);
      }
    },
    [connectedHostIds, connectingHostId, saveConnectedHostIds],
  );

  const connectLocalHost = useCallback(async () => {
    if (connectingHostId !== null) {
      return;
    }
    setConnectingHostId("local");
    try {
      await verifyWsHostConnection(localControlConnectionUrl, { timeoutMs: 2_500 });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not verify local host.",
        description:
          error instanceof Error ? error.message : "Local host connection check did not complete.",
      });
    } finally {
      setConnectingHostId(null);
    }
  }, [connectingHostId, localControlConnectionUrl]);

  const createPairingLink = useCallback(async () => {
    if (!remoteRelaySettings.enabled) {
      toastManager.add({
        type: "warning",
        title: "Remote relay is disabled.",
        description: "Enable the remote relay before creating a pairing link.",
      });
      return;
    }
    const pairingName = pairingLabel.trim();
    if (pairingName.length === 0) {
      toastManager.add({
        type: "warning",
        title: "Device label is required.",
        description: "Set a label before creating a pairing link.",
      });
      return;
    }
    setCreatingPairingLink(true);
    try {
      const created = await createHostPairingSession({
        wsUrl: localAdvertisedWsUrl,
        ...(localDeviceConnection.authToken ? { authToken: localDeviceConnection.authToken } : {}),
        name: pairingName,
      });
      const connectionString = buildHostPairingConnectionString({
        name: pairingName,
        sessionId: created.sessionId,
        secret: created.secret,
        ...(created.claimUrl ? { claimUrl: created.claimUrl } : {}),
        ...(created.pollingUrl ? { pollingUrl: created.pollingUrl } : {}),
        ...(created.relayUrl ? { relayUrl: created.relayUrl } : {}),
        ...(created.hostDeviceId ? { hostDeviceId: created.hostDeviceId } : {}),
        ...(created.hostIdentityPublicKey
          ? { hostIdentityPublicKey: created.hostIdentityPublicKey }
          : {}),
        expiresAt: created.expiresAt,
      });
      const qrDataUrl = await QRCode.toDataURL(connectionString, {
        margin: 1,
        width: 220,
      });
      setPairingLink({
        sessionId: created.sessionId,
        connectionString,
        expiresAt: created.expiresAt,
        qrDataUrl,
      });
      setPairingSessionStatus(created);
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
  }, [
    localAdvertisedWsUrl,
    localDeviceConnection.authToken,
    pairingLabel,
    remoteRelaySettings.enabled,
  ]);

  const revokePairingLink = useCallback(async () => {
    if (!pairingLink) {
      return;
    }
    setRevokingPairingLink(true);
    try {
      const revoked = await revokeHostPairingSession({
        wsUrl: localAdvertisedWsUrl,
        ...(localDeviceConnection.authToken ? { authToken: localDeviceConnection.authToken } : {}),
        sessionId: pairingLink.sessionId,
      });
      setPairingSessionStatus(revoked);
      toastManager.add({
        type: "success",
        title: "Pairing link revoked.",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not revoke pairing link.",
        description: error instanceof Error ? error.message : "Pairing link revoke failed.",
      });
    } finally {
      setRevokingPairingLink(false);
    }
  }, [localAdvertisedWsUrl, localDeviceConnection.authToken, pairingLink]);

  useEffect(() => {
    if (!pairingLink) {
      setPairingSessionStatus(null);
      return;
    }
    let cancelled = false;

    const refreshStatus = async () => {
      try {
        const status = await readHostPairingSession({
          wsUrl: localAdvertisedWsUrl,
          ...(localDeviceConnection.authToken
            ? { authToken: localDeviceConnection.authToken }
            : {}),
          sessionId: pairingLink.sessionId,
        });
        if (!cancelled) {
          setPairingSessionStatus(status);
        }
      } catch {
        if (!cancelled) {
          setPairingSessionStatus(null);
        }
      }
    };

    void refreshStatus();
    const interval = window.setInterval(() => {
      void refreshStatus();
    }, 1_200);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [localAdvertisedWsUrl, localDeviceConnection.authToken, pairingLink]);

  const refreshPairedSessions = useCallback(
    async (options?: { readonly quiet?: boolean }) => {
      if (!options?.quiet) {
        setRefreshingPairedSessions(true);
      }
      try {
        const sessions = await listHostPairingSessions({
          wsUrl: localAdvertisedWsUrl,
          ...(localDeviceConnection.authToken
            ? { authToken: localDeviceConnection.authToken }
            : {}),
        });
        setPairedSessions(sessions);
      } catch (error) {
        if (!options?.quiet) {
          toastManager.add({
            type: "error",
            title: "Could not load paired devices.",
            description: error instanceof Error ? error.message : "Failed to fetch paired devices.",
          });
        }
      } finally {
        if (!options?.quiet) {
          setRefreshingPairedSessions(false);
        }
      }
    },
    [localAdvertisedWsUrl, localDeviceConnection.authToken],
  );

  const revokePairedSession = useCallback(
    async (session: HostPairingSessionSummary) => {
      const confirmed = await ensureNativeApi().dialogs.confirm(
        `Revoke access for "${session.requesterName ?? session.name}"?`,
      );
      if (!confirmed) {
        return;
      }
      setRevokingPairedSessionIds((current) => ({ ...current, [session.sessionId]: true }));
      try {
        const revoked = await revokeHostPairingSession({
          wsUrl: localAdvertisedWsUrl,
          ...(localDeviceConnection.authToken
            ? { authToken: localDeviceConnection.authToken }
            : {}),
          sessionId: session.sessionId,
        });
        setPairedSessions((current) =>
          current.map((entry) =>
            entry.sessionId === session.sessionId
              ? {
                  ...entry,
                  status: revoked.status,
                  ...(revoked.requesterName ? { requesterName: revoked.requesterName } : {}),
                  ...(revoked.claimId ? { claimId: revoked.claimId } : {}),
                  ...(entry.resolvedAt ? { resolvedAt: entry.resolvedAt } : {}),
                }
              : entry,
          ),
        );
        toastManager.add({
          type: "success",
          title: "Device access revoked.",
        });
        await refreshPairedSessions({ quiet: true });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not revoke device access.",
          description: error instanceof Error ? error.message : "Pairing session revoke failed.",
        });
      } finally {
        setRevokingPairedSessionIds((current) => {
          const next = { ...current };
          delete next[session.sessionId];
          return next;
        });
      }
    },
    [localAdvertisedWsUrl, localDeviceConnection.authToken, refreshPairedSessions],
  );

  useEffect(() => {
    void refreshPairedSessions({ quiet: true });
    const interval = window.setInterval(() => {
      void refreshPairedSessions({ quiet: true });
    }, 4_000);
    return () => {
      window.clearInterval(interval);
    };
  }, [refreshPairedSessions]);

  const refreshHostAvailability = useCallback(async () => {
    if (hosts.length === 0) {
      return;
    }
    const requestId = Date.now();
    await Promise.all(
      hosts.map(async (host) => {
        setHostAvailability((current) => ({
          ...current,
          [host.id]: { status: "checking", requestId },
        }));
        try {
          await verifyWsHostConnection(resolveHostConnectionWsUrl(host), { timeoutMs: 3_500 });
          setHostAvailability((current) => {
            if (current[host.id]?.requestId !== requestId) return current;
            return { ...current, [host.id]: { status: "available", requestId } };
          });
        } catch (error) {
          const message = error instanceof Error ? error.message.toLowerCase() : "";
          const unauthenticated =
            message.includes("invalid") ||
            message.includes("unauthorized") ||
            message.includes("401");
          setHostAvailability((current) => {
            if (current[host.id]?.requestId !== requestId) return current;
            return {
              ...current,
              [host.id]: { status: unauthenticated ? "unauthenticated" : "unavailable", requestId },
            };
          });
        }
      }),
    );
  }, [hosts]);

  useEffect(() => {
    void refreshHostAvailability();
    let cancelled = false;
    let handle: ReturnType<typeof setTimeout> | number | null = null;
    const schedule = () => {
      handle = window.setTimeout(() => {
        if (cancelled) {
          return;
        }
        void refreshHostAvailability();
        schedule();
      }, resolveAvailabilityPollDelayMs());
    };
    schedule();
    return () => {
      cancelled = true;
      if (handle !== null) {
        window.clearTimeout(handle);
      }
    };
  }, [refreshHostAvailability]);

  return (
    <SettingsPageContainer>
      <div className="grid gap-2.5 sm:grid-cols-3">
        <div className={`${SETTINGS_INLINE_PANEL_MUTED_CLASS_NAME} px-3 py-2`}>
          <div className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground/55 uppercase">
            Host role
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-[13px] font-medium text-foreground/88">
            <LaptopIcon className="size-3.5 text-muted-foreground/65" />
            Main host
          </div>
        </div>
        <div className={`${SETTINGS_INLINE_PANEL_MUTED_CLASS_NAME} px-3 py-2`}>
          <div className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground/55 uppercase">
            Relay
          </div>
          <div className="mt-1">
            <DeviceStatusBadge tone={remoteRelaySettings.enabled ? "success" : "neutral"}>
              {remoteRelaySettings.enabled ? "Enabled" : "Disabled"}
            </DeviceStatusBadge>
          </div>
        </div>
        <div className={`${SETTINGS_INLINE_PANEL_MUTED_CLASS_NAME} px-3 py-2`}>
          <div className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground/55 uppercase">
            Remote hosts
          </div>
          <div className="mt-1 text-[13px] font-medium text-foreground/88">
            {connectedHostIds.length}/{hosts.length} connected
          </div>
        </div>
      </div>

      <DeviceSection
        title="Local host"
        description="Share this machine through a pairing link or direct host URL."
        icon={<LaptopIcon className="size-3.5" />}
        actions={
          <>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void refreshLocalEndpoint()}
              disabled={refreshingLocalEndpoint}
            >
              {refreshingLocalEndpoint ? "Refreshing..." : "Refresh"}
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void connectLocalHost()}
              disabled={connectingHostId !== null}
            >
              {connectingHostId === "local" ? "Checking..." : "Verify"}
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => copyToClipboard(localShareConnectionUrl, { label: "Host URL" })}
            >
              <CopyIcon className="size-3.5" />
              Copy URL
            </Button>
          </>
        }
      >
        <div className="space-y-3 p-3 sm:p-4">
          <div className={`${SETTINGS_INLINE_PANEL_MUTED_CLASS_NAME} px-3 py-2.5`}>
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-foreground/88">Local endpoint</div>
                <div className="mt-1 break-all font-mono text-[11px] text-foreground">
                  {localAdvertisedWsUrl}
                </div>
              </div>
              <DeviceStatusBadge tone="info">Main host</DeviceStatusBadge>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground/62">
              <span>
                {localDeviceConnection.authToken
                  ? "Host auth token enabled"
                  : "No host auth token configured"}
              </span>
              <span>This device remains the primary host.</span>
            </div>
          </div>

          <DeviceSubPanel
            title="Pairing link"
            description={
              remoteRelaySettings.enabled
                ? "Create a one-time link for another device."
                : "Relay pairing is unavailable while the remote relay is disabled."
            }
            actions={
              <>
                {pairingLink ? (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => void revokePairingLink()}
                    disabled={revokingPairingLink}
                  >
                    {revokingPairingLink ? "Revoking..." : "Revoke link"}
                  </Button>
                ) : null}
                <Button
                  size="xs"
                  onClick={() => void createPairingLink()}
                  disabled={creatingPairingLink || !remoteRelaySettings.enabled}
                >
                  {creatingPairingLink ? "Creating..." : "Create link"}
                </Button>
              </>
            }
          >
            <div className="max-w-xl">
              <Input
                value={pairingLabel}
                onChange={(event) => {
                  setPairingLabel(event.currentTarget.value);
                }}
                placeholder="Device label (for example: Office Mac mini)"
              />
            </div>
            {pairingLink ? (
              <div className="mt-3 space-y-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <code
                    className={`${SETTINGS_INLINE_PANEL_MUTED_CLASS_NAME} max-w-full break-all px-2 py-1 text-[10px]`}
                  >
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
                    <PopoverTrigger className={SETTINGS_POPOVER_TRIGGER_CLASS_NAME}>
                      <QrCodeIcon className="size-3.5" />
                      QR
                    </PopoverTrigger>
                    <PopoverPopup side="bottom" align="end" className="w-fit p-2">
                      <div className={`${SETTINGS_INLINE_PANEL_CLASS_NAME} w-fit p-2`}>
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
                {pairingSessionStatus ? (
                  <div
                    className={`${SETTINGS_INLINE_PANEL_MUTED_CLASS_NAME} px-2 py-1.5 text-[11px] text-muted-foreground`}
                  >
                    {pairingSessionStatus.status === "waiting-claim"
                      ? "Waiting for a device to claim this pairing link."
                      : pairingSessionStatus.status === "claim-pending"
                        ? `Auto-approving ${pairingSessionStatus.requesterName ?? "remote device"}...`
                        : pairingSessionStatus.status === "approved"
                          ? "Pairing completed."
                          : pairingSessionStatus.status === "rejected"
                            ? "Pairing request was rejected."
                            : "Pairing link expired."}
                  </div>
                ) : null}
              </div>
            ) : null}
          </DeviceSubPanel>

          <DeviceSubPanel
            title="Remote relay"
            description="Used for new pairings and daemon registration."
            actions={
              <>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    updateSettings({
                      remoteRelay: {
                        enabled: remoteRelaySettings.enabled,
                        defaultUrl: DEFAULT_MANAGED_RELAY_URL,
                        allowInsecureLocalUrls: remoteRelaySettings.allowInsecureLocalUrls,
                      },
                    });
                  }}
                >
                  Reset
                </Button>
                <Button size="xs" onClick={saveRelaySettings}>
                  Save relay
                </Button>
              </>
            }
          >
            <div className="space-y-3">
              <label
                className={`${SETTINGS_INLINE_PANEL_CLASS_NAME} flex h-9 items-center gap-2 px-3 text-[12px] text-muted-foreground`}
              >
                <Switch
                  checked={remoteRelaySettings.enabled}
                  onCheckedChange={toggleRemoteRelayEnabled}
                />
                <span>Enable remote relay</span>
              </label>
              <div className="grid gap-2">
                <Input
                  value={relayUrlDraft}
                  onChange={(event) => setRelayUrlDraft(event.currentTarget.value)}
                  placeholder={DEFAULT_MANAGED_RELAY_URL}
                />
                <label
                  className={`${SETTINGS_INLINE_PANEL_CLASS_NAME} flex h-9 w-fit items-center gap-2 px-2.5 text-[12px] text-muted-foreground`}
                >
                  <Switch
                    checked={remoteRelaySettings.allowInsecureLocalUrls}
                    onCheckedChange={toggleInsecureRelayUrls}
                  />
                  <span>Allow local ws://</span>
                </label>
              </div>
              <div
                className={`${SETTINGS_INLINE_PANEL_MUTED_CLASS_NAME} px-3 py-2 text-[12px] text-muted-foreground`}
              >
                {!remoteRelaySettings.enabled ? (
                  "Remote relay is disabled."
                ) : hasPinnedRelayMismatch ? (
                  <span className="text-warning-foreground">
                    Some paired devices were created against another relay URL.
                  </span>
                ) : serverConfig?.relay ? (
                  <>
                    Host device:{" "}
                    <span className="font-mono text-foreground">{serverConfig.relay.deviceId}</span>
                  </>
                ) : (
                  <>Managed default: {DEFAULT_MANAGED_RELAY_URL}</>
                )}
              </div>
              {relayRegistrations.length === 0 ? null : (
                <div className="space-y-2">
                  {relayRegistrations.map((registration) => (
                    <div
                      key={registration.relayUrl}
                      className={`${SETTINGS_INLINE_PANEL_MUTED_CLASS_NAME} flex min-w-0 flex-wrap items-center gap-2 px-2.5 py-2 text-[12px]`}
                    >
                      {registration.status === "connected" ? (
                        <CheckCircle2Icon className="size-3.5 text-success-foreground" />
                      ) : registration.status === "connecting" ? (
                        <ShieldAlertIcon className="size-3.5 text-warning-foreground" />
                      ) : (
                        <CircleOffIcon className="size-3.5 text-destructive-foreground" />
                      )}
                      <span className="min-w-0 break-all font-mono text-foreground">
                        {registration.relayUrl}
                      </span>
                      <span className="text-muted-foreground">{registration.status}</span>
                      {registration.connectedAt ? (
                        <span className="text-muted-foreground">
                          since {formatRelativeTimeLabel(registration.connectedAt)}
                        </span>
                      ) : null}
                      {registration.lastError ? (
                        <span className="text-destructive-foreground">
                          {registration.lastError}
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </DeviceSubPanel>

          <DeviceSubPanel
            title="Paired devices"
            description="Devices that requested access through this host's pairing links."
            actions={
              <Button
                size="xs"
                variant="outline"
                onClick={() => void refreshPairedSessions()}
                disabled={refreshingPairedSessions}
              >
                {refreshingPairedSessions ? "Refreshing..." : "Refresh"}
              </Button>
            }
          >
            {pairedSessions.length === 0 ? (
              <div
                className={`${SETTINGS_INLINE_PANEL_MUTED_CLASS_NAME} px-3 py-2 text-[12px] text-muted-foreground`}
              >
                No paired devices yet.
              </div>
            ) : (
              <div className="space-y-2">
                {pairedSessions.map((session) => (
                  <div
                    key={session.sessionId}
                    className={`${SETTINGS_INLINE_PANEL_MUTED_CLASS_NAME} flex min-w-0 flex-col gap-2 px-2.5 py-2 sm:flex-row sm:items-center`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-foreground/90">
                        {session.requesterName ?? "Unnamed device"}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {session.name}
                      </div>
                    </div>
                    <DeviceStatusBadge
                      tone={
                        session.status === "approved"
                          ? "success"
                          : session.status === "claim-pending" || session.status === "waiting-claim"
                            ? "warning"
                            : "neutral"
                      }
                    >
                      {session.status === "waiting-claim"
                        ? "Waiting"
                        : session.status === "claim-pending"
                          ? "Pending"
                          : session.status === "approved"
                            ? "Approved"
                            : session.status === "rejected"
                              ? "Rejected"
                              : "Expired"}
                    </DeviceStatusBadge>
                    <span className="text-[11px] text-muted-foreground">
                      {session.resolvedAt
                        ? `Updated ${formatRelativeTimeLabel(session.resolvedAt)}`
                        : `Created ${formatRelativeTimeLabel(session.createdAt)}`}
                    </span>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => void revokePairedSession(session)}
                      disabled={Boolean(revokingPairedSessionIds[session.sessionId])}
                    >
                      {revokingPairedSessionIds[session.sessionId] ? "Revoking..." : "Revoke"}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </DeviceSubPanel>
        </div>
      </DeviceSection>

      <DeviceSection
        title="Remote hosts"
        description={
          desktopMode
            ? "Save devices you want to connect to from this workspace."
            : "Web mode supports one remote host entry."
        }
        icon={<ScanLineIcon className="size-3.5" />}
        actions={
          <Button size="xs" variant="outline" onClick={() => void refreshHostAvailability()}>
            Refresh status
          </Button>
        }
      >
        <div className="space-y-3 p-3 sm:p-4">
          <DeviceSubPanel
            title={editingHostId ? "Edit host" : "Add host"}
            description={
              editingHostId
                ? "Update the saved label, icon, and connection string."
                : "Paste a pairing link or host connection string."
            }
            actions={
              <>
                {editingHostId ? (
                  <Button size="xs" variant="outline" onClick={clearHostDraft}>
                    <XIcon className="size-3.5" />
                    Cancel
                  </Button>
                ) : null}
                <Button size="xs" onClick={() => void addRemoteHost()} disabled={importingHost}>
                  {importingHost ? "Saving..." : editingHostId ? "Save host" : "Add host"}
                </Button>
              </>
            }
          >
            <div className="grid gap-2">
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
                placeholder="ace://pair?... or ws://host:3773/ws?token=..."
              />
              <div className="flex flex-wrap items-center gap-2">
                <label
                  className={`${SETTINGS_INLINE_PANEL_CLASS_NAME} flex h-9 items-center gap-1.5 px-2 text-[12px] text-muted-foreground`}
                >
                  <span>Icon</span>
                  <select
                    className={SETTINGS_NATIVE_SELECT_CLASS_NAME}
                    value={hostDraft.iconGlyph ?? "folder"}
                    onChange={(event) => {
                      const value = event.currentTarget.value as RemoteHostInstance["iconGlyph"];
                      setHostDraft((previous) => ({ ...previous, iconGlyph: value }));
                    }}
                  >
                    {PROJECT_ICON_OPTIONS.map((option) => (
                      <option key={option.glyph} value={option.glyph}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label
                  className={`${SETTINGS_INLINE_PANEL_CLASS_NAME} flex h-9 items-center gap-1.5 px-2 text-[12px] text-muted-foreground`}
                >
                  <span>Color</span>
                  <select
                    className={SETTINGS_NATIVE_SELECT_CLASS_NAME}
                    value={hostDraft.iconColor ?? "slate"}
                    onChange={(event) => {
                      const value = event.currentTarget.value as RemoteHostInstance["iconColor"];
                      setHostDraft((previous) => ({ ...previous, iconColor: value }));
                    }}
                  >
                    {PROJECT_ICON_COLOR_OPTIONS.map((option) => (
                      <option key={option.color} value={option.color}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div
                  className={`${SETTINGS_INLINE_PANEL_MUTED_CLASS_NAME} inline-flex h-9 min-w-0 items-center gap-1.5 px-2 text-[12px] text-muted-foreground`}
                >
                  <span>Preview</span>
                  <ProjectGlyphIcon
                    icon={{
                      glyph: hostDraft.iconGlyph ?? "folder",
                      color: hostDraft.iconColor ?? "slate",
                    }}
                    className="size-3.5"
                  />
                  <span className="max-w-40 truncate text-foreground">
                    {hostDraft.name.trim() || "Remote host"}
                  </span>
                </div>
              </div>
            </div>
          </DeviceSubPanel>

          <div className="space-y-2">
            <div className="px-0.5 text-[10px] font-semibold tracking-[0.12em] text-muted-foreground/55 uppercase">
              Saved hosts
            </div>
            {hosts.length === 0 ? (
              <div
                className={`${SETTINGS_INLINE_PANEL_MUTED_CLASS_NAME} px-3 py-2 text-[12px] text-muted-foreground`}
              >
                {desktopMode ? "No remote hosts saved yet." : "No remote host saved yet."}
              </div>
            ) : (
              sortedHosts.map((host) => {
                const isConnected = connectedHostIds.includes(host.id);
                const connectionString = resolveHostConnectionWsUrl(host);
                const connectionDescriptor = describeHostConnection({
                  wsUrl: host.wsUrl,
                  authToken: host.authToken,
                });
                const description =
                  connectionDescriptor.kind === "relay"
                    ? `${connectionDescriptor.summary} · ${connectionDescriptor.detail}`
                    : connectionDescriptor.summary;
                const availability = hostAvailability[host.id]?.status;

                return (
                  <div
                    key={host.id}
                    className={`${SETTINGS_INLINE_PANEL_MUTED_CLASS_NAME} flex min-w-0 flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center`}
                  >
                    <ProjectGlyphIcon
                      icon={{
                        glyph: host.iconGlyph ?? "folder",
                        color: host.iconColor ?? "slate",
                      }}
                      className="size-5 shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <span className="truncate text-[13px] font-medium text-foreground/90">
                          {host.name}
                        </span>
                        {isConnected ? (
                          <DeviceStatusBadge tone="info">Connected</DeviceStatusBadge>
                        ) : null}
                        {availability === "available" ? (
                          <DeviceStatusBadge tone="success">
                            <CheckCircle2Icon className="size-3" />
                            Available
                          </DeviceStatusBadge>
                        ) : availability === "unauthenticated" ? (
                          <DeviceStatusBadge tone="warning">
                            <ShieldAlertIcon className="size-3" />
                            Unauthenticated
                          </DeviceStatusBadge>
                        ) : availability === "checking" ? (
                          <DeviceStatusBadge tone="neutral">Checking</DeviceStatusBadge>
                        ) : (
                          <DeviceStatusBadge tone="neutral">
                            <CircleOffIcon className="size-3" />
                            Unavailable
                          </DeviceStatusBadge>
                        )}
                      </div>
                      <div className="mt-1 min-w-0 break-words text-[11px] text-muted-foreground/62">
                        {description}
                      </div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground/52">
                        Last connected:{" "}
                        {host.lastConnectedAt
                          ? formatRelativeTimeLabel(host.lastConnectedAt)
                          : "never"}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                      <Button
                        size="xs"
                        variant={isConnected ? "outline" : "default"}
                        onClick={() =>
                          isConnected ? void disconnectHost(host) : void connectHost(host)
                        }
                        disabled={connectingHostId !== null}
                      >
                        {connectingHostId === host.id
                          ? isConnected
                            ? "Disconnecting..."
                            : "Connecting..."
                          : isConnected
                            ? "Disconnect"
                            : "Connect"}
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => void checkHostAvailability(host)}
                        disabled={checkingHostId !== null || connectingHostId !== null}
                      >
                        {checkingHostId === host.id ? "Checking..." : "Check"}
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => startEditingHost(host)}
                        disabled={checkingHostId !== null || connectingHostId !== null}
                      >
                        Edit
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
                      <Button size="xs" variant="destructive" onClick={() => void removeHost(host)}>
                        <Trash2Icon className="size-3.5" />
                        Remove
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </DeviceSection>
    </SettingsPageContainer>
  );
}
