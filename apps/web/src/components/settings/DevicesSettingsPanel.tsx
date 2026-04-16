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
import QRCode from "qrcode";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isElectron } from "../../env";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureNativeApi } from "../../nativeApi";
import {
  buildHostPairingConnectionString,
  connectToWsHost,
  createHostPairingSession,
  createRemoteHostInstance,
  isHostConnectionActive,
  listHostPairingSessions,
  loadPinnedRemoteHostIds,
  loadRemoteHostInstances,
  parseHostConnectionQrPayload,
  persistPinnedRemoteHostIds,
  persistRemoteHostInstances,
  readHostPairingAdvertisedEndpoint,
  readHostPairingSession,
  revokeHostPairingSession,
  resolveHostConnectionWsUrl,
  resolveActiveWsUrl,
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
  registerRemoteRoute,
  unregisterRemoteRoute,
} from "../../lib/remoteWsRouter";
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
  const [hosts, setHosts] = useState<RemoteHostInstance[]>(() =>
    normalizeHostsForMode(loadRemoteHostInstances(), desktopMode),
  );
  const [pinnedHostIds, setPinnedHostIds] = useState<string[]>(() => loadPinnedRemoteHostIds());
  const [hostDraft, setHostDraft] = useState<HostDraftState>(EMPTY_HOST_DRAFT);
  const [editingHostId, setEditingHostId] = useState<string | null>(null);
  const [importingHost, setImportingHost] = useState(false);
  const [advertisedLocalWsUrl, setAdvertisedLocalWsUrl] = useState<string | null>(null);
  const [refreshingLocalEndpoint, setRefreshingLocalEndpoint] = useState(false);
  const [pairingLabel, setPairingLabel] = useState("");
  const [pairingLink, setPairingLink] = useState<PairingLinkState | null>(null);
  const [creatingPairingLink, setCreatingPairingLink] = useState(false);
  const [revokingPairingLink, setRevokingPairingLink] = useState(false);
  const [pairingSessionStatus, setPairingSessionStatus] = useState<HostPairingSessionStatus | null>(
    null,
  );
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
  const [activeWsUrl, setActiveWsUrl] = useState(() => resolveActiveWsUrl());
  const localControlConnectionUrl = useMemo(
    () =>
      resolveHostConnectionWsUrl({
        wsUrl: localDeviceConnection.wsUrl,
        authToken: localDeviceConnection.authToken,
      }),
    [localDeviceConnection.authToken, localDeviceConnection.wsUrl],
  );
  const localHostIsActive = useMemo(
    () => isHostConnectionActive(localDeviceConnection, activeWsUrl),
    [activeWsUrl, localDeviceConnection],
  );
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handleHostChange = () => {
      setActiveWsUrl(resolveActiveWsUrl());
    };
    window.addEventListener("ace:ws-host-changed", handleHostChange);
    return () => {
      window.removeEventListener("ace:ws-host-changed", handleHostChange);
    };
  }, []);
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

  const savePinnedHostIds = useCallback((nextPinnedHostIds: ReadonlyArray<string>) => {
    const deduped = [...new Set(nextPinnedHostIds.filter((hostId) => hostId.trim().length > 0))];
    setPinnedHostIds(deduped);
    persistPinnedRemoteHostIds(deduped);
  }, []);

  const clearHostDraft = useCallback(() => {
    setHostDraft(EMPTY_HOST_DRAFT);
    setEditingHostId(null);
  }, []);

  const sortedHosts = useMemo(() => {
    const pinnedIds = new Set(pinnedHostIds);
    return [...hosts].toSorted((left, right) => {
      const leftPinned = pinnedIds.has(left.id) ? 1 : 0;
      const rightPinned = pinnedIds.has(right.id) ? 1 : 0;
      if (leftPinned !== rightPinned) {
        return rightPinned - leftPinned;
      }
      const leftLastConnectedAt = Date.parse(left.lastConnectedAt ?? "") || 0;
      const rightLastConnectedAt = Date.parse(right.lastConnectedAt ?? "") || 0;
      if (leftLastConnectedAt !== rightLastConnectedAt) {
        return rightLastConnectedAt - leftLastConnectedAt;
      }
      return left.name.localeCompare(right.name);
    });
  }, [hosts, pinnedHostIds]);

  useEffect(() => {
    const availableHostIds = new Set(hosts.map((host) => host.id));
    const nextPinnedHostIds = pinnedHostIds.filter((hostId) => availableHostIds.has(hostId));
    if (nextPinnedHostIds.length !== pinnedHostIds.length) {
      savePinnedHostIds(nextPinnedHostIds);
    }
  }, [hosts, pinnedHostIds, savePinnedHostIds]);

  useEffect(() => {
    const nextConnectionUrls = new Set(
      hosts
        .filter((host) => pinnedHostIds.includes(host.id))
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
  }, [hosts, pinnedHostIds]);

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
      const editingHost = editingHostId
        ? hosts.find((host) => host.id === editingHostId)
        : undefined;
      const resolvedDraft =
        parsed.kind === "pairing"
          ? await resolvePairingHostConnection(parsed.pairing, {
              requesterName: desktopMode ? "ace desktop" : "ace web",
            })
          : parsed.draft;

      const upsertedHost = upsertHost(
        {
          name: hostDraft.name.trim() || resolvedDraft.name || "",
          wsUrl: resolvedDraft.wsUrl,
          ...(resolvedDraft.authToken ? { authToken: resolvedDraft.authToken } : {}),
          ...(hostDraft.iconGlyph ? { iconGlyph: hostDraft.iconGlyph } : {}),
          ...(hostDraft.iconColor ? { iconColor: hostDraft.iconColor } : {}),
        },
        editingHost?.id,
      );
      if (!pinnedHostIds.includes(upsertedHost.id)) {
        savePinnedHostIds([...pinnedHostIds, upsertedHost.id]);
      }
      clearHostDraft();
      toastManager.add({
        type: "success",
        title: editingHost ? "Remote host updated." : "Remote host added.",
      });

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
    desktopMode,
    editingHostId,
    hostDraft.connection,
    hostDraft.iconColor,
    hostDraft.iconGlyph,
    hostDraft.name,
    hosts,
    pinnedHostIds,
    savePinnedHostIds,
    upsertHost,
  ]);

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
      savePinnedHostIds(pinnedHostIds.filter((hostId) => hostId !== host.id));
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
    [clearHostDraft, editingHostId, hosts, pinnedHostIds, saveHosts, savePinnedHostIds],
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
      if (connectingHostId !== null) {
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
        connectToWsHost(connectionString);
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
    [connectingHostId, markHostLastConnected],
  );

  const connectLocalHost = useCallback(async () => {
    if (connectingHostId !== null || localHostIsActive) {
      return;
    }
    setConnectingHostId("local");
    try {
      await verifyWsHostConnection(localControlConnectionUrl, {
        timeoutMs: 2_500,
      });
      connectToWsHost(localControlConnectionUrl);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not switch to local host.",
        description:
          error instanceof Error ? error.message : "Local host connection check did not complete.",
      });
    } finally {
      setConnectingHostId(null);
    }
  }, [connectingHostId, localControlConnectionUrl, localHostIsActive]);

  const togglePinnedHost = useCallback(
    (hostId: string) => {
      if (pinnedHostIds.includes(hostId)) {
        savePinnedHostIds(pinnedHostIds.filter((candidateId) => candidateId !== hostId));
        return;
      }
      savePinnedHostIds([...pinnedHostIds, hostId]);
    },
    [pinnedHostIds, savePinnedHostIds],
  );

  const createPairingLink = useCallback(async () => {
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
      const advertisedEndpoint = await readHostPairingAdvertisedEndpoint({
        wsUrl: localAdvertisedWsUrl,
        ...(localDeviceConnection.authToken ? { authToken: localDeviceConnection.authToken } : {}),
      });
      const connectionString = buildHostPairingConnectionString({
        name: pairingName,
        wsUrl: advertisedEndpoint.wsUrl,
        sessionId: created.sessionId,
        secret: created.secret,
        ...(created.claimUrl ? { claimUrl: created.claimUrl } : {}),
        ...(created.pollingUrl ? { pollingUrl: created.pollingUrl } : {}),
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
  }, [localAdvertisedWsUrl, localDeviceConnection.authToken, pairingLabel]);

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
          await readHostPairingAdvertisedEndpoint({
            wsUrl: host.wsUrl,
            ...(host.authToken ? { authToken: host.authToken } : {}),
          });
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
      <SettingsSection title="Local host" icon={<LaptopIcon className="size-3.5" />}>
        <SettingsRow
          title="Local endpoint"
          description="Share this host with other devices on your network or tailnet."
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
                variant={localHostIsActive ? "outline" : "default"}
                onClick={() => void connectLocalHost()}
                disabled={localHostIsActive || connectingHostId !== null}
              >
                {localHostIsActive
                  ? "Active"
                  : connectingHostId === "local"
                    ? "Switching…"
                    : "Use local"}
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
          description="Set a device label, then create a one-time pairing link for another device."
          control={
            <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
              {pairingLink ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => void revokePairingLink()}
                  disabled={revokingPairingLink}
                >
                  {revokingPairingLink ? "Revoking…" : "Revoke Link"}
                </Button>
              ) : null}
              <Button
                size="xs"
                onClick={() => void createPairingLink()}
                disabled={creatingPairingLink}
              >
                {creatingPairingLink ? "Creating…" : "Create Link"}
              </Button>
            </div>
          }
        >
          <div className="mt-3 max-w-md">
            <Input
              value={pairingLabel}
              onChange={(event) => {
                setPairingLabel(event.currentTarget.value);
              }}
              placeholder="Device label (for example: Office Mac mini)"
            />
          </div>
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
              {pairingSessionStatus ? (
                <div className="w-full rounded-md border border-border/60 bg-muted/20 px-2 py-1.5 text-[11px] text-muted-foreground">
                  {pairingSessionStatus.status === "waiting-claim"
                    ? "Waiting for a device to claim this pairing link."
                    : pairingSessionStatus.status === "claim-pending"
                      ? `Auto-approving ${pairingSessionStatus.requesterName ?? "remote device"}…`
                      : pairingSessionStatus.status === "approved"
                        ? "Pairing completed."
                        : pairingSessionStatus.status === "rejected"
                          ? "Pairing request was rejected."
                          : "Pairing link expired."}
                </div>
              ) : null}
            </div>
          ) : null}
        </SettingsRow>

        <SettingsRow
          title="Paired devices"
          description="Devices that requested access through this host's pairing links. Revoke any device directly from this list."
          control={
            <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
              <Button
                size="xs"
                variant="outline"
                onClick={() => void refreshPairedSessions()}
                disabled={refreshingPairedSessions}
              >
                {refreshingPairedSessions ? "Refreshing…" : "Refresh"}
              </Button>
            </div>
          }
        >
          {pairedSessions.length === 0 ? (
            <div className="mt-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
              No paired devices yet.
            </div>
          ) : (
            <div className="mt-3 space-y-2">
              {pairedSessions.map((session) => (
                <div
                  key={session.sessionId}
                  className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-background/60 px-2.5 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-foreground">
                      {session.requesterName ?? "Unnamed device"}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">{session.name}</div>
                  </div>
                  <span
                    className={`rounded border px-1.5 py-0.5 text-[10px] ${
                      session.status === "approved"
                        ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-300"
                        : session.status === "claim-pending" || session.status === "waiting-claim"
                          ? "border-amber-500/35 bg-amber-500/10 text-amber-300"
                          : "border-border/70 bg-muted/40 text-muted-foreground"
                    }`}
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
                  </span>
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
                    {revokingPairedSessionIds[session.sessionId] ? "Revoking…" : "Revoke"}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Remote hosts" icon={<ScanLineIcon className="size-3.5" />}>
        <SettingsRow
          title={editingHostId ? "Edit remote host" : "Add remote host"}
          description={
            desktopMode
              ? editingHostId
                ? "Update host label, icon, and connection details."
                : "Paste a pairing link or host connection string."
              : "Web mode supports one remote host entry."
          }
          control={
            <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
              <Button size="xs" variant="outline" onClick={() => void refreshHostAvailability()}>
                Refresh status
              </Button>
              {editingHostId ? (
                <Button size="xs" variant="outline" onClick={clearHostDraft}>
                  <XIcon className="size-3.5" />
                  Cancel
                </Button>
              ) : null}
              <Button size="xs" onClick={() => void addRemoteHost()} disabled={importingHost}>
                {importingHost ? "Saving…" : editingHostId ? "Save host" : "Add host"}
              </Button>
            </div>
          }
        >
          <div className="mt-3 grid gap-3">
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
              <Input
                value={hostDraft.name}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setHostDraft((previous) => ({ ...previous, name: value }));
                }}
                placeholder="Device name"
              />
              <label className="flex items-center gap-1.5 rounded-md border border-border/70 bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground">
                <span>Icon</span>
                <select
                  className="h-6 rounded border border-border/70 bg-background px-1.5 text-xs text-foreground"
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
              <label className="flex items-center gap-1.5 rounded-md border border-border/70 bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground">
                <span>Color</span>
                <select
                  className="h-6 rounded border border-border/70 bg-background px-1.5 text-xs text-foreground"
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
            </div>
            <Input
              value={hostDraft.connection}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setHostDraft((previous) => ({ ...previous, connection: value }));
              }}
              placeholder="ace://pair?... or ws://host:3773/ws?token=..."
            />
            <div className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border/70 bg-background px-2 py-1 text-xs text-muted-foreground">
              <span>Preview</span>
              <ProjectGlyphIcon
                icon={{
                  glyph: hostDraft.iconGlyph ?? "folder",
                  color: hostDraft.iconColor ?? "slate",
                }}
                className="size-3.5"
              />
              <span className="text-foreground">{hostDraft.name.trim() || "Remote host"}</span>
            </div>
          </div>
        </SettingsRow>

        {hosts.length === 0 ? (
          <SettingsRow
            title="Saved hosts"
            description={desktopMode ? "No remote hosts saved yet." : "No remote host saved yet."}
          />
        ) : (
          sortedHosts.map((host) => {
            const isPinned = pinnedHostIds.includes(host.id);
            const connectionString = resolveHostConnectionWsUrl(host);
            const isActive = isHostConnectionActive(host, activeWsUrl);
            return (
              <SettingsRow
                key={host.id}
                title={host.name}
                description={host.wsUrl}
                status={
                  <>
                    <span className="block">
                      {hostAvailability[host.id]?.status === "available" ? (
                        <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-300">
                          <CheckCircle2Icon className="size-3.5" />
                          Available
                        </span>
                      ) : hostAvailability[host.id]?.status === "unauthenticated" ? (
                        <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-300">
                          <ShieldAlertIcon className="size-3.5" />
                          Unauthenticated
                        </span>
                      ) : hostAvailability[host.id]?.status === "checking" ? (
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
                    {isPinned ? (
                      <span className="mt-1 inline-flex items-center gap-1 rounded border border-blue-500/35 bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-300">
                        Pinned
                      </span>
                    ) : null}
                    {isActive ? (
                      <span className="mt-1 inline-flex items-center gap-1 rounded border border-emerald-500/35 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300">
                        Active host
                      </span>
                    ) : null}
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
                      onClick={() => void connectHost(host)}
                      disabled={isActive || connectingHostId !== null}
                    >
                      {isActive
                        ? "Active"
                        : connectingHostId === host.id
                          ? "Connecting…"
                          : "Connect"}
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => void checkHostAvailability(host)}
                      disabled={checkingHostId !== null || connectingHostId !== null}
                    >
                      {checkingHostId === host.id ? "Checking…" : "Check"}
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => togglePinnedHost(host.id)}
                      disabled={checkingHostId !== null || connectingHostId !== null}
                    >
                      {isPinned ? "Unpin" : "Pin"}
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
                    <Button size="xs" variant="ghost" onClick={() => void removeHost(host)}>
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
