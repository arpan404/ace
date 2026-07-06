import {
  CheckCircle2Icon,
  CircleOffIcon,
  CopyIcon,
  QrCodeIcon,
  ShieldAlertIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { DEFAULT_MANAGED_RELAY_URL } from "@ace/contracts";
import { describeHostConnection } from "@ace/shared/hostConnections";
import QRCode from "qrcode";
import { useEffect, useReducer, useRef, useState } from "react";
import { validateRelayWebSocketUrl } from "@ace/shared/relay";

import { isElectron } from "../../env";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useStableCallback } from "../../hooks/useStableCallback";
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
import { PROJECT_ICON_COLOR_OPTIONS, PROJECT_ICON_OPTIONS } from "../projectAvatarOptions";
import { ProjectGlyphIcon } from "../ProjectAvatar";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsInput, SettingsPageContainer } from "./SettingsPanelPrimitives";
import { SETTINGS_FIELD_CLASS, SETTINGS_COMPACT_ACTION_BUTTON_CLASS } from "./settingsUi";
import { DeviceSection } from "./DeviceSection";
import { DeviceStatusBadge } from "./DeviceStatusBadge";
import { DeviceSubPanel } from "./DeviceSubPanel";
const SETTINGS_NEUTRAL_ACTION_BUTTON_CLASS_NAME =
  "border-border/40 bg-foreground/[0.08] text-foreground hover:bg-foreground/[0.12] active:bg-foreground/[0.16]";
const DEVICE_ACTION_BUTTON_CLASS_NAME = SETTINGS_COMPACT_ACTION_BUTTON_CLASS;
const DEVICE_NEUTRAL_ACTION_BUTTON_CLASS_NAME = cn(
  SETTINGS_COMPACT_ACTION_BUTTON_CLASS,
  SETTINGS_NEUTRAL_ACTION_BUTTON_CLASS_NAME,
);
const DEVICE_INSET_PANEL_CLASS_NAME =
  "overflow-hidden rounded-[0.9rem] border border-border/40 glass-inset";
const DEVICE_INSET_PANEL_MUTED_CLASS_NAME =
  "overflow-hidden rounded-[0.9rem] border border-border/40 bg-muted/10";

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

type DevicesPanelState = {
  hostDraft: HostDraftState;
  editingHostId: string | null;
  importingHost: boolean;
  advertisedLocalWsUrl: string | null;
  refreshingLocalEndpoint: boolean;
  pairingLabel: string;
  relayUrlDraft: string;
  checkingHostId: string | null;
  connectingHostId: string | "local" | null;
};

type DevicesPanelAction =
  | { type: "set-host-draft"; hostDraft: HostDraftState }
  | { type: "update-host-draft"; hostDraft: Partial<HostDraftState> }
  | { type: "set-editing-host-id"; editingHostId: string | null }
  | { type: "clear-host-draft" }
  | { type: "set-importing-host"; importingHost: boolean }
  | { type: "set-advertised-local-ws-url"; advertisedLocalWsUrl: string | null }
  | { type: "set-refreshing-local-endpoint"; refreshingLocalEndpoint: boolean }
  | { type: "set-pairing-label"; pairingLabel: string }
  | { type: "set-relay-url-draft"; relayUrlDraft: string }
  | { type: "set-checking-host-id"; checkingHostId: string | null }
  | { type: "set-connecting-host-id"; connectingHostId: string | "local" | null };

function devicesPanelStateReducer(
  state: DevicesPanelState,
  action: DevicesPanelAction,
): DevicesPanelState {
  switch (action.type) {
    case "set-host-draft":
      return state.hostDraft === action.hostDraft
        ? state
        : { ...state, hostDraft: action.hostDraft };
    case "update-host-draft":
      return { ...state, hostDraft: { ...state.hostDraft, ...action.hostDraft } };
    case "set-editing-host-id":
      return state.editingHostId === action.editingHostId
        ? state
        : { ...state, editingHostId: action.editingHostId };
    case "clear-host-draft":
      return state.hostDraft === EMPTY_HOST_DRAFT && state.editingHostId === null
        ? state
        : { ...state, hostDraft: EMPTY_HOST_DRAFT, editingHostId: null };
    case "set-importing-host":
      return state.importingHost === action.importingHost
        ? state
        : { ...state, importingHost: action.importingHost };
    case "set-advertised-local-ws-url":
      return state.advertisedLocalWsUrl === action.advertisedLocalWsUrl
        ? state
        : { ...state, advertisedLocalWsUrl: action.advertisedLocalWsUrl };
    case "set-refreshing-local-endpoint":
      return state.refreshingLocalEndpoint === action.refreshingLocalEndpoint
        ? state
        : { ...state, refreshingLocalEndpoint: action.refreshingLocalEndpoint };
    case "set-pairing-label":
      return state.pairingLabel === action.pairingLabel
        ? state
        : { ...state, pairingLabel: action.pairingLabel };
    case "set-relay-url-draft":
      return state.relayUrlDraft === action.relayUrlDraft
        ? state
        : { ...state, relayUrlDraft: action.relayUrlDraft };
    case "set-checking-host-id":
      return state.checkingHostId === action.checkingHostId
        ? state
        : { ...state, checkingHostId: action.checkingHostId };
    case "set-connecting-host-id":
      return state.connectingHostId === action.connectingHostId
        ? state
        : { ...state, connectingHostId: action.connectingHostId };
  }
}

interface PairingUiState {
  readonly pairingLink: PairingLinkState | null;
  readonly pairingSessionStatus: HostPairingSessionStatus | null;
  readonly creatingPairingLink: boolean;
  readonly revokingPairingLink: boolean;
}

type HostAvailabilityState = {
  status: "checking" | "available" | "unavailable" | "unauthenticated";
  requestId: number;
};

type DevicesSessionState = {
  pairedSessions: ReadonlyArray<HostPairingSessionSummary>;
  refreshingPairedSessions: boolean;
  revokingPairedSessionIds: Record<string, boolean>;
  hostAvailability: Record<string, HostAvailabilityState>;
};

type DevicesSessionAction =
  | { type: "set-paired-sessions"; pairedSessions: ReadonlyArray<HostPairingSessionSummary> }
  | { type: "set-refreshing-paired-sessions"; refreshingPairedSessions: boolean }
  | { type: "set-revoking-paired-session"; sessionId: string; revoking: boolean }
  | { type: "set-host-availability"; hostId: string; availability: HostAvailabilityState };

function devicesSessionStateReducer(
  state: DevicesSessionState,
  action: DevicesSessionAction,
): DevicesSessionState {
  switch (action.type) {
    case "set-paired-sessions":
      return state.pairedSessions === action.pairedSessions
        ? state
        : { ...state, pairedSessions: action.pairedSessions };
    case "set-refreshing-paired-sessions":
      return state.refreshingPairedSessions === action.refreshingPairedSessions
        ? state
        : { ...state, refreshingPairedSessions: action.refreshingPairedSessions };
    case "set-revoking-paired-session": {
      if (action.revoking) {
        if (state.revokingPairedSessionIds[action.sessionId]) {
          return state;
        }
        return {
          ...state,
          revokingPairedSessionIds: {
            ...state.revokingPairedSessionIds,
            [action.sessionId]: true,
          },
        };
      }
      if (!(action.sessionId in state.revokingPairedSessionIds)) {
        return state;
      }
      const next = { ...state.revokingPairedSessionIds };
      delete next[action.sessionId];
      return { ...state, revokingPairedSessionIds: next };
    }
    case "set-host-availability":
      return {
        ...state,
        hostAvailability: {
          ...state.hostAvailability,
          [action.hostId]: action.availability,
        },
      };
  }
}

type PairingUiAction =
  | { type: "set-pairing-link"; pairingLink: PairingLinkState | null }
  | { type: "set-session-status"; pairingSessionStatus: HostPairingSessionStatus | null }
  | { type: "set-creating"; creatingPairingLink: boolean }
  | { type: "set-revoking"; revokingPairingLink: boolean };

const EMPTY_PAIRING_UI_STATE: PairingUiState = {
  pairingLink: null,
  pairingSessionStatus: null,
  creatingPairingLink: false,
  revokingPairingLink: false,
};

function pairingUiStateReducer(state: PairingUiState, action: PairingUiAction): PairingUiState {
  switch (action.type) {
    case "set-pairing-link":
      return state.pairingLink === action.pairingLink
        ? state
        : { ...state, pairingLink: action.pairingLink };
    case "set-session-status":
      return state.pairingSessionStatus === action.pairingSessionStatus
        ? state
        : { ...state, pairingSessionStatus: action.pairingSessionStatus };
    case "set-creating":
      return state.creatingPairingLink === action.creatingPairingLink
        ? state
        : { ...state, creatingPairingLink: action.creatingPairingLink };
    case "set-revoking":
      return state.revokingPairingLink === action.revokingPairingLink
        ? state
        : { ...state, revokingPairingLink: action.revokingPairingLink };
  }
}

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

function useDevicesSettingsPanelComponent() {
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
  const [panelState, dispatchPanelState] = useReducer(devicesPanelStateReducer, {
    hostDraft: EMPTY_HOST_DRAFT,
    editingHostId: null,
    importingHost: false,
    advertisedLocalWsUrl: null,
    refreshingLocalEndpoint: false,
    pairingLabel: "",
    relayUrlDraft: remoteRelaySettings.defaultUrl,
    checkingHostId: null,
    connectingHostId: null,
  });
  const {
    hostDraft,
    editingHostId,
    importingHost,
    advertisedLocalWsUrl,
    refreshingLocalEndpoint,
    pairingLabel,
    relayUrlDraft,
    checkingHostId,
    connectingHostId,
  } = panelState;
  const [pairingUiState, dispatchPairingUi] = useReducer(
    pairingUiStateReducer,
    EMPTY_PAIRING_UI_STATE,
  );
  const { pairingLink, pairingSessionStatus, creatingPairingLink, revokingPairingLink } =
    pairingUiState;
  const [sessionState, dispatchSessionState] = useReducer(devicesSessionStateReducer, {
    pairedSessions: [],
    refreshingPairedSessions: false,
    revokingPairedSessionIds: {},
    hostAvailability: {},
  });
  const { pairedSessions, refreshingPairedSessions, revokingPairedSessionIds, hostAvailability } =
    sessionState;
  const registeredRouteConnectionUrlsRef = useRef<Set<string>>(null!);
  if (registeredRouteConnectionUrlsRef.current === null) {
    registeredRouteConnectionUrlsRef.current = new Set<string>();
  }
  const importingHostRef = useRef(importingHost);
  const localDeviceConnection = splitWsUrlAuthToken(resolveLocalDeviceWsUrl());
  useEffect(() => {
    importingHostRef.current = importingHost;
  }, [importingHost]);
  useEffect(() => {
    dispatchPanelState({
      type: "set-relay-url-draft",
      relayUrlDraft: remoteRelaySettings.defaultUrl,
    });
  }, [remoteRelaySettings.defaultUrl]);
  const localControlConnectionUrl = resolveHostConnectionWsUrl({
    wsUrl: localDeviceConnection.wsUrl,
    authToken: localDeviceConnection.authToken,
  });
  const localAdvertisedWsUrl = advertisedLocalWsUrl ?? localDeviceConnection.wsUrl;
  const localShareConnectionUrl = resolveHostConnectionWsUrl({
    wsUrl: localAdvertisedWsUrl,
    authToken: localDeviceConnection.authToken,
  });
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

  const saveHosts = (nextHosts: RemoteHostInstance[]) => {
    const normalizedHosts = normalizeHostsForMode(nextHosts, desktopMode);
    setHosts(normalizedHosts);
    persistRemoteHostInstances(normalizedHosts);
  };

  const saveConnectedHostIds = (nextConnectedHostIds: ReadonlyArray<string>) => {
    const deduped = [...new Set(nextConnectedHostIds.filter((hostId) => hostId.trim().length > 0))];
    setConnectedHostIds(deduped);
    persistConnectedRemoteHostIds(deduped);
  };

  const clearHostDraft = () => {
    dispatchPanelState({ type: "clear-host-draft" });
  };

  const sortedHosts = (() => {
    const availableHostIds = new Set(hosts.map((host) => host.id));
    const visibleConnectedHostIds = connectedHostIds.filter((hostId) =>
      availableHostIds.has(hostId),
    );
    const connectedIds = new Set(visibleConnectedHostIds);
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
  })();

  const pinnedRelayUrls = Array.from(
    new Set(pairedSessions.flatMap((session) => (session.relayUrl ? [session.relayUrl] : []))),
  );
  const relayRegistrations = serverConfig?.relay?.registrations ?? [];
  const hasPinnedRelayMismatch = pinnedRelayUrls.some(
    (relayUrl) => relayUrl !== remoteRelaySettings.defaultUrl,
  );

  useEffect(() => {
    const availableHostIds = new Set(hosts.map((host) => host.id));
    const visibleConnectedHostIds = connectedHostIds.filter((hostId) =>
      availableHostIds.has(hostId),
    );
    const connectedHostIdSet = new Set(visibleConnectedHostIds);
    const nextConnectionUrls = new Set<string>();
    for (const host of hosts) {
      if (!connectedHostIdSet.has(host.id)) {
        continue;
      }
      nextConnectionUrls.add(resolveHostConnectionWsUrl(host));
    }
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
  }, [connectedHostIds, hosts]);

  useEffect(
    () => () => {
      for (const connectionUrl of registeredRouteConnectionUrlsRef.current) {
        unregisterRemoteRoute(connectionUrl);
      }
      registeredRouteConnectionUrlsRef.current.clear();
    },
    [],
  );

  const refreshLocalEndpoint = useStableCallback(async () => {
    dispatchPanelState({ type: "set-refreshing-local-endpoint", refreshingLocalEndpoint: true });
    try {
      const endpoint = await readHostPairingAdvertisedEndpoint({
        wsUrl: localDeviceConnection.wsUrl,
        ...(localDeviceConnection.authToken ? { authToken: localDeviceConnection.authToken } : {}),
      });
      dispatchPanelState({
        type: "set-advertised-local-ws-url",
        advertisedLocalWsUrl: endpoint.wsUrl,
      });
    } catch {
      dispatchPanelState({ type: "set-advertised-local-ws-url", advertisedLocalWsUrl: null });
      dispatchPanelState({
        type: "set-refreshing-local-endpoint",
        refreshingLocalEndpoint: false,
      });
      return;
    }
    dispatchPanelState({
      type: "set-refreshing-local-endpoint",
      refreshingLocalEndpoint: false,
    });
  });

  const saveRelaySettings = () => {
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
      dispatchPanelState({ type: "set-relay-url-draft", relayUrlDraft: normalized });
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
  };

  const toggleInsecureRelayUrls = (allow: boolean) => {
    updateSettings({
      remoteRelay: {
        enabled: remoteRelaySettings.enabled,
        defaultUrl: relayUrlDraft,
        allowInsecureLocalUrls: allow,
      },
    });
  };

  const toggleRemoteRelayEnabled = (enabled: boolean) => {
    updateSettings({
      remoteRelay: {
        enabled,
        defaultUrl: relayUrlDraft,
        allowInsecureLocalUrls: remoteRelaySettings.allowInsecureLocalUrls,
      },
    });
  };

  const markHostLastConnected = (hostId: string) => {
    const nowIso = new Date().toISOString();
    saveHosts(
      hosts.map((candidate) =>
        candidate.id === hostId ? { ...candidate, lastConnectedAt: nowIso } : candidate,
      ),
    );
  };

  useEffect(() => {
    void refreshLocalEndpoint();
  }, [refreshLocalEndpoint]);

  const upsertHost = (
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
      (candidate) => candidate.wsUrl === created.wsUrl && candidate.authToken === created.authToken,
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
  };

  const importRemoteHostConnection = async (
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
      dispatchSessionState({
        type: "set-host-availability",
        hostId: upsertedHost.id,
        availability: { status: "available", requestId: Date.now() },
      });
    } catch (error) {
      dispatchSessionState({
        type: "set-host-availability",
        hostId: upsertedHost.id,
        availability: { status: "unavailable", requestId: Date.now() },
      });
      toastManager.add({
        type: "warning",
        title: "Host saved but currently unavailable.",
        description:
          error instanceof Error ? error.message : "Could not reach this host right now.",
      });
    }

    return upsertedHost;
  };

  const consumePendingDesktopPairingLink = useStableCallback((onSettled?: () => void) => {
    if (!desktopMode || importingHostRef.current) {
      return;
    }
    const pendingPairingLink = takePendingDesktopPairingLink();
    if (!pendingPairingLink) {
      return;
    }
    let active = true;
    importingHostRef.current = true;
    dispatchPanelState({ type: "set-importing-host", importingHost: true });
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
        onSettled?.();
        if (active) {
          importingHostRef.current = false;
          dispatchPanelState({ type: "set-importing-host", importingHost: false });
        }
      });
    return () => {
      active = false;
    };
  });

  useEffect(() => {
    if (!desktopMode) {
      return;
    }
    let pendingDesktopPairingCleanup: (() => void) | null = null;
    const clearPendingDesktopPairingCleanup = () => {
      pendingDesktopPairingCleanup = null;
    };
    const unsubscribe = subscribeToDesktopPairingLinks(() => {
      if (pendingDesktopPairingCleanup !== null) {
        return;
      }
      pendingDesktopPairingCleanup =
        consumePendingDesktopPairingLink(clearPendingDesktopPairingCleanup) ?? null;
    });
    return () => {
      pendingDesktopPairingCleanup?.();
      pendingDesktopPairingCleanup = null;
      unsubscribe();
    };
  }, [consumePendingDesktopPairingLink, desktopMode]);

  const addRemoteHost = async () => {
    dispatchPanelState({ type: "set-importing-host", importingHost: true });
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
      dispatchPanelState({ type: "set-importing-host", importingHost: false });
      return;
    }
    dispatchPanelState({ type: "set-importing-host", importingHost: false });
  };

  const startEditingHost = (host: RemoteHostInstance) => {
    dispatchPanelState({ type: "set-editing-host-id", editingHostId: host.id });
    dispatchPanelState({
      type: "set-host-draft",
      hostDraft: {
        name: host.name,
        connection: resolveHostConnectionWsUrl(host),
        iconGlyph: host.iconGlyph ?? "folder",
        iconColor: host.iconColor ?? "slate",
      },
    });
  };

  const removeHost = async (host: RemoteHostInstance) => {
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
  };

  const checkHostAvailability = useStableCallback(async (host: RemoteHostInstance) => {
    if (checkingHostId !== null) {
      return;
    }
    dispatchPanelState({ type: "set-checking-host-id", checkingHostId: host.id });
    try {
      await verifyWsHostConnection(resolveHostConnectionWsUrl(host), {
        timeoutMs: 2_500,
      });
      dispatchSessionState({
        type: "set-host-availability",
        hostId: host.id,
        availability: { status: "available", requestId: Date.now() },
      });
    } catch (error) {
      dispatchSessionState({
        type: "set-host-availability",
        hostId: host.id,
        availability: { status: "unavailable", requestId: Date.now() },
      });
      toastManager.add({
        type: "error",
        title: "Host is unavailable.",
        description:
          error instanceof Error ? error.message : "Host connection check did not complete.",
      });
      dispatchPanelState({ type: "set-checking-host-id", checkingHostId: null });
      return;
    }
    dispatchPanelState({ type: "set-checking-host-id", checkingHostId: null });
  });

  const connectHost = useStableCallback(async (host: RemoteHostInstance) => {
    if (connectingHostId !== null || connectedHostIds.includes(host.id)) {
      return;
    }
    const connectionString = resolveHostConnectionWsUrl(host);
    dispatchPanelState({ type: "set-connecting-host-id", connectingHostId: host.id });
    try {
      await verifyWsHostConnection(connectionString, {
        timeoutMs: 2_500,
      });
      dispatchSessionState({
        type: "set-host-availability",
        hostId: host.id,
        availability: { status: "available", requestId: Date.now() },
      });
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
      dispatchSessionState({
        type: "set-host-availability",
        hostId: host.id,
        availability: { status: "unavailable", requestId: Date.now() },
      });
      toastManager.add({
        type: "error",
        title: "Could not connect to remote host.",
        description:
          error instanceof Error ? error.message : "Host connection check did not complete.",
      });
      dispatchPanelState({ type: "set-connecting-host-id", connectingHostId: null });
      return;
    }
    dispatchPanelState({ type: "set-connecting-host-id", connectingHostId: null });
  });

  const disconnectHost = async (host: RemoteHostInstance) => {
    if (connectingHostId !== null || !connectedHostIds.includes(host.id)) {
      return;
    }
    dispatchPanelState({ type: "set-connecting-host-id", connectingHostId: host.id });
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
      dispatchPanelState({ type: "set-connecting-host-id", connectingHostId: null });
      return;
    }
    dispatchPanelState({ type: "set-connecting-host-id", connectingHostId: null });
  };

  const connectLocalHost = async () => {
    if (connectingHostId !== null) {
      return;
    }
    dispatchPanelState({ type: "set-connecting-host-id", connectingHostId: "local" });
    try {
      await verifyWsHostConnection(localControlConnectionUrl, { timeoutMs: 2_500 });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not verify local host.",
        description:
          error instanceof Error ? error.message : "Local host connection check did not complete.",
      });
      dispatchPanelState({ type: "set-connecting-host-id", connectingHostId: null });
      return;
    }
    dispatchPanelState({ type: "set-connecting-host-id", connectingHostId: null });
  };

  const createPairingLink = async () => {
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
    dispatchPairingUi({ type: "set-creating", creatingPairingLink: true });
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
      dispatchPairingUi({
        type: "set-pairing-link",
        pairingLink: {
          sessionId: created.sessionId,
          connectionString,
          expiresAt: created.expiresAt,
          qrDataUrl,
        },
      });
      dispatchPairingUi({ type: "set-session-status", pairingSessionStatus: created });
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
      dispatchPairingUi({ type: "set-creating", creatingPairingLink: false });
      return;
    }
    dispatchPairingUi({ type: "set-creating", creatingPairingLink: false });
  };

  const revokePairingLink = async () => {
    if (!pairingLink) {
      return;
    }
    dispatchPairingUi({ type: "set-revoking", revokingPairingLink: true });
    try {
      const revoked = await revokeHostPairingSession({
        wsUrl: localAdvertisedWsUrl,
        ...(localDeviceConnection.authToken ? { authToken: localDeviceConnection.authToken } : {}),
        sessionId: pairingLink.sessionId,
      });
      dispatchPairingUi({ type: "set-session-status", pairingSessionStatus: revoked });
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
      dispatchPairingUi({ type: "set-revoking", revokingPairingLink: false });
      return;
    }
    dispatchPairingUi({ type: "set-revoking", revokingPairingLink: false });
  };

  useEffect(() => {
    if (!pairingLink) {
      dispatchPairingUi({ type: "set-session-status", pairingSessionStatus: null });
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
          dispatchPairingUi({ type: "set-session-status", pairingSessionStatus: status });
        }
      } catch {
        if (!cancelled) {
          dispatchPairingUi({ type: "set-session-status", pairingSessionStatus: null });
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

  const refreshPairedSessions = useStableCallback(
    async (options?: { readonly quiet?: boolean }) => {
      if (!options?.quiet) {
        dispatchSessionState({
          type: "set-refreshing-paired-sessions",
          refreshingPairedSessions: true,
        });
      }
      try {
        const sessions = await listHostPairingSessions({
          wsUrl: localAdvertisedWsUrl,
          ...(localDeviceConnection.authToken
            ? { authToken: localDeviceConnection.authToken }
            : {}),
        });
        dispatchSessionState({ type: "set-paired-sessions", pairedSessions: sessions });
      } catch (error) {
        if (!options?.quiet) {
          toastManager.add({
            type: "error",
            title: "Could not load paired devices.",
            description: error instanceof Error ? error.message : "Failed to fetch paired devices.",
          });
        }
        if (!options?.quiet) {
          dispatchSessionState({
            type: "set-refreshing-paired-sessions",
            refreshingPairedSessions: false,
          });
        }
        return;
      }
      if (!options?.quiet) {
        dispatchSessionState({
          type: "set-refreshing-paired-sessions",
          refreshingPairedSessions: false,
        });
      }
    },
  );

  const revokePairedSession = async (session: HostPairingSessionSummary) => {
    const confirmed = await ensureNativeApi().dialogs.confirm(
      `Revoke access for "${session.requesterName ?? session.name}"?`,
    );
    if (!confirmed) {
      return;
    }
    dispatchSessionState({
      type: "set-revoking-paired-session",
      sessionId: session.sessionId,
      revoking: true,
    });
    try {
      const revoked = await revokeHostPairingSession({
        wsUrl: localAdvertisedWsUrl,
        ...(localDeviceConnection.authToken ? { authToken: localDeviceConnection.authToken } : {}),
        sessionId: session.sessionId,
      });
      dispatchSessionState({
        type: "set-paired-sessions",
        pairedSessions: pairedSessions.map((entry) =>
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
      });
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
      dispatchSessionState({
        type: "set-revoking-paired-session",
        sessionId: session.sessionId,
        revoking: false,
      });
      return;
    }
    dispatchSessionState({
      type: "set-revoking-paired-session",
      sessionId: session.sessionId,
      revoking: false,
    });
  };

  useEffect(() => {
    void refreshPairedSessions({ quiet: true });
    const interval = window.setInterval(() => {
      void refreshPairedSessions({ quiet: true });
    }, 4_000);
    return () => {
      window.clearInterval(interval);
    };
  }, [refreshPairedSessions]);

  const refreshHostAvailability = useStableCallback(async () => {
    if (hosts.length === 0) {
      return;
    }
    const requestId = Date.now();
    await Promise.all(
      hosts.map(async (host) => {
        dispatchSessionState({
          type: "set-host-availability",
          hostId: host.id,
          availability: { status: "checking", requestId },
        });
        try {
          await verifyWsHostConnection(resolveHostConnectionWsUrl(host), { timeoutMs: 3_500 });
          dispatchSessionState({
            type: "set-host-availability",
            hostId: host.id,
            availability: { status: "available", requestId },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message.toLowerCase() : "";
          const unauthenticated =
            message.includes("invalid") ||
            message.includes("unauthorized") ||
            message.includes("401");
          dispatchSessionState({
            type: "set-host-availability",
            hostId: host.id,
            availability: {
              status: unauthenticated ? "unauthenticated" : "unavailable",
              requestId,
            },
          });
        }
      }),
    );
  });

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
      <DeviceSection
        title="Local host"
        description="Share this machine through a pairing link or direct host URL."
        actions={
          <>
            <Button
              size="xs"
              variant="outline"
              className={DEVICE_ACTION_BUTTON_CLASS_NAME}
              onClick={() => void refreshLocalEndpoint()}
              disabled={refreshingLocalEndpoint}
            >
              {refreshingLocalEndpoint ? "Refreshing..." : "Refresh"}
            </Button>
            <Button
              size="xs"
              variant="outline"
              className={DEVICE_ACTION_BUTTON_CLASS_NAME}
              onClick={() => void connectLocalHost()}
              disabled={connectingHostId !== null}
            >
              {connectingHostId === "local" ? "Checking..." : "Verify"}
            </Button>
            <Button
              size="xs"
              variant="outline"
              className={DEVICE_ACTION_BUTTON_CLASS_NAME}
              onClick={() => copyToClipboard(localShareConnectionUrl, { label: "Host URL" })}
            >
              <CopyIcon className="size-3" />
              Copy URL
            </Button>
          </>
        }
      >
        <div className="space-y-0">
          <div className={`${DEVICE_INSET_PANEL_MUTED_CLASS_NAME} px-3 py-2.5`}>
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-foreground/88">Local endpoint</div>
                <div className="mt-1 break-all font-mono text-xs text-foreground">
                  {localAdvertisedWsUrl}
                </div>
              </div>
              <DeviceStatusBadge tone="info">Main host</DeviceStatusBadge>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground/62">
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
                    className={DEVICE_ACTION_BUTTON_CLASS_NAME}
                    onClick={() => void revokePairingLink()}
                    disabled={revokingPairingLink}
                  >
                    {revokingPairingLink ? "Revoking..." : "Revoke link"}
                  </Button>
                ) : null}
                <Button
                  size="xs"
                  className={DEVICE_NEUTRAL_ACTION_BUTTON_CLASS_NAME}
                  onClick={() => void createPairingLink()}
                  disabled={creatingPairingLink || !remoteRelaySettings.enabled}
                >
                  {creatingPairingLink ? "Creating..." : "Create link"}
                </Button>
              </>
            }
          >
            <div className="max-w-xl">
              <SettingsInput
                value={pairingLabel}
                onChange={(event) => {
                  dispatchPanelState({
                    type: "set-pairing-label",
                    pairingLabel: event.currentTarget.value,
                  });
                }}
                placeholder="Device label (for example: Office Mac mini)"
              />
            </div>
            {pairingLink ? (
              <div className="mt-3 space-y-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <code
                    className={`${DEVICE_INSET_PANEL_MUTED_CLASS_NAME} max-w-full break-all px-2 py-1 text-[10px]`}
                  >
                    {maskPairingLinkForDisplay(pairingLink.connectionString)}
                  </code>
                  <Button
                    size="xs"
                    variant="outline"
                    className={DEVICE_ACTION_BUTTON_CLASS_NAME}
                    onClick={() =>
                      copyToClipboard(pairingLink.connectionString, {
                        label: "Pairing link",
                      })
                    }
                  >
                    <CopyIcon className="size-3" />
                    Copy link
                  </Button>
                  <Popover>
                    <PopoverTrigger
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className={cn(
                            SETTINGS_FIELD_CLASS,
                            "h-8 gap-1.5 px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground",
                          )}
                        />
                      }
                    >
                      <QrCodeIcon className="size-3.5" />
                      QR
                    </PopoverTrigger>
                    <PopoverPopup side="bottom" align="end" className="w-fit p-2">
                      <div className={`${DEVICE_INSET_PANEL_CLASS_NAME} w-fit p-2`}>
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
                    className={`${DEVICE_INSET_PANEL_MUTED_CLASS_NAME} px-2 py-1.5 text-xs text-muted-foreground`}
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
                  className={DEVICE_ACTION_BUTTON_CLASS_NAME}
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
                <Button
                  size="xs"
                  className={DEVICE_NEUTRAL_ACTION_BUTTON_CLASS_NAME}
                  onClick={saveRelaySettings}
                >
                  Save relay
                </Button>
              </>
            }
          >
            <div className="space-y-3">
              <label
                htmlFor="remote-relay-enabled"
                className={`${DEVICE_INSET_PANEL_CLASS_NAME} flex h-9 items-center gap-2 px-3 text-sm text-muted-foreground`}
              >
                <Switch
                  id="remote-relay-enabled"
                  checked={remoteRelaySettings.enabled}
                  onCheckedChange={toggleRemoteRelayEnabled}
                />
                <span>Enable remote relay</span>
              </label>
              <div className="grid gap-2">
                <SettingsInput
                  value={relayUrlDraft}
                  onChange={(event) =>
                    dispatchPanelState({
                      type: "set-relay-url-draft",
                      relayUrlDraft: event.currentTarget.value,
                    })
                  }
                  placeholder={DEFAULT_MANAGED_RELAY_URL}
                />
                <label
                  htmlFor="remote-relay-allow-local-ws"
                  className={`${DEVICE_INSET_PANEL_CLASS_NAME} flex h-9 w-fit items-center gap-2 px-2.5 text-sm text-muted-foreground`}
                >
                  <Switch
                    id="remote-relay-allow-local-ws"
                    checked={remoteRelaySettings.allowInsecureLocalUrls}
                    onCheckedChange={toggleInsecureRelayUrls}
                  />
                  <span>Allow local ws://</span>
                </label>
              </div>
              <div
                className={`${DEVICE_INSET_PANEL_MUTED_CLASS_NAME} px-3 py-2 text-sm text-muted-foreground`}
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
                      className={`${DEVICE_INSET_PANEL_MUTED_CLASS_NAME} flex min-w-0 flex-wrap items-center gap-2 px-2.5 py-2 text-sm`}
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
                className={DEVICE_ACTION_BUTTON_CLASS_NAME}
                onClick={() => void refreshPairedSessions()}
                disabled={refreshingPairedSessions}
              >
                {refreshingPairedSessions ? "Refreshing..." : "Refresh"}
              </Button>
            }
          >
            {pairedSessions.length === 0 ? (
              <div
                className={`${DEVICE_INSET_PANEL_MUTED_CLASS_NAME} px-3 py-2 text-sm text-muted-foreground`}
              >
                No paired devices yet.
              </div>
            ) : (
              <div className="space-y-2">
                {pairedSessions.map((session) => (
                  <div
                    key={session.sessionId}
                    className={`${DEVICE_INSET_PANEL_MUTED_CLASS_NAME} flex min-w-0 flex-col gap-2 px-2.5 py-2 sm:flex-row sm:items-center`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-foreground/90">
                        {session.requesterName ?? "Unnamed device"}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">{session.name}</div>
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
                    <span className="text-xs text-muted-foreground">
                      {session.resolvedAt
                        ? `Updated ${formatRelativeTimeLabel(session.resolvedAt)}`
                        : `Created ${formatRelativeTimeLabel(session.createdAt)}`}
                    </span>
                    <Button
                      size="xs"
                      variant="outline"
                      className={DEVICE_ACTION_BUTTON_CLASS_NAME}
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
        actions={
          <Button
            size="xs"
            variant="outline"
            className={DEVICE_ACTION_BUTTON_CLASS_NAME}
            onClick={() => void refreshHostAvailability()}
          >
            Refresh status
          </Button>
        }
      >
        <div className="space-y-0">
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
                  <Button
                    size="xs"
                    variant="outline"
                    className={DEVICE_ACTION_BUTTON_CLASS_NAME}
                    onClick={clearHostDraft}
                  >
                    <XIcon className="size-3" />
                    Cancel
                  </Button>
                ) : null}
                <Button
                  size="xs"
                  className={DEVICE_NEUTRAL_ACTION_BUTTON_CLASS_NAME}
                  onClick={() => void addRemoteHost()}
                  disabled={importingHost}
                >
                  {importingHost ? "Saving..." : editingHostId ? "Save host" : "Add host"}
                </Button>
              </>
            }
          >
            <div className="grid gap-2">
              <SettingsInput
                value={hostDraft.name}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  dispatchPanelState({ type: "update-host-draft", hostDraft: { name: value } });
                }}
                placeholder="Device name"
              />
              <SettingsInput
                value={hostDraft.connection}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  dispatchPanelState({
                    type: "update-host-draft",
                    hostDraft: { connection: value },
                  });
                }}
                placeholder="ace://pair?... or ws://host:3773/ws?token=..."
              />
              <div className="flex flex-wrap items-center gap-2">
                <label
                  className={`${DEVICE_INSET_PANEL_CLASS_NAME} flex h-9 items-center gap-1.5 px-2 text-sm text-muted-foreground`}
                >
                  <span>Icon</span>
                  <Select
                    value={hostDraft.iconGlyph ?? "folder"}
                    onValueChange={(value) => {
                      if (value === null) return;
                      dispatchPanelState({
                        type: "update-host-draft",
                        hostDraft: {
                          iconGlyph: value as RemoteHostInstance["iconGlyph"],
                        },
                      });
                    }}
                  >
                    <SelectTrigger
                      className={cn("w-auto min-w-28", SETTINGS_FIELD_CLASS)}
                      aria-label="Host icon"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {PROJECT_ICON_OPTIONS.map((option) => (
                        <SelectItem key={option.glyph} value={option.glyph}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </label>
                <label
                  className={`${DEVICE_INSET_PANEL_CLASS_NAME} flex h-9 items-center gap-1.5 px-2 text-sm text-muted-foreground`}
                >
                  <span>Color</span>
                  <Select
                    value={hostDraft.iconColor ?? "slate"}
                    onValueChange={(value) => {
                      if (value === null) return;
                      dispatchPanelState({
                        type: "update-host-draft",
                        hostDraft: {
                          iconColor: value as RemoteHostInstance["iconColor"],
                        },
                      });
                    }}
                  >
                    <SelectTrigger
                      className={cn("w-auto min-w-28", SETTINGS_FIELD_CLASS)}
                      aria-label="Host icon color"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {PROJECT_ICON_COLOR_OPTIONS.map((option) => (
                        <SelectItem key={option.color} value={option.color}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </label>
                <div
                  className={`${DEVICE_INSET_PANEL_MUTED_CLASS_NAME} inline-flex h-9 min-w-0 items-center gap-1.5 px-2 text-sm text-muted-foreground`}
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
                className={`${DEVICE_INSET_PANEL_MUTED_CLASS_NAME} px-3 py-2 text-sm text-muted-foreground`}
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
                    className={`${DEVICE_INSET_PANEL_MUTED_CLASS_NAME} flex min-w-0 flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center`}
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
                      <div className="mt-1 min-w-0 break-words text-xs text-muted-foreground/62">
                        {description}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground/52">
                        Last connected:{" "}
                        {host.lastConnectedAt
                          ? formatRelativeTimeLabel(host.lastConnectedAt)
                          : "never"}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                      <Button
                        size="xs"
                        variant={isConnected ? "outline" : "default"}
                        className={
                          isConnected
                            ? DEVICE_ACTION_BUTTON_CLASS_NAME
                            : DEVICE_NEUTRAL_ACTION_BUTTON_CLASS_NAME
                        }
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
                        className={DEVICE_ACTION_BUTTON_CLASS_NAME}
                        onClick={() => void checkHostAvailability(host)}
                        disabled={checkingHostId !== null || connectingHostId !== null}
                      >
                        {checkingHostId === host.id ? "Checking..." : "Check"}
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        className={DEVICE_ACTION_BUTTON_CLASS_NAME}
                        onClick={() => startEditingHost(host)}
                        disabled={checkingHostId !== null || connectingHostId !== null}
                      >
                        Edit
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        className={DEVICE_ACTION_BUTTON_CLASS_NAME}
                        onClick={() =>
                          copyToClipboard(connectionString, { label: "Connection string" })
                        }
                      >
                        Copy string
                      </Button>
                      <Button
                        size="xs"
                        variant="destructive"
                        className={DEVICE_ACTION_BUTTON_CLASS_NAME}
                        onClick={() => void removeHost(host)}
                      >
                        <Trash2Icon className="size-3" />
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

export function DevicesSettingsPanel() {
  return useDevicesSettingsPanelComponent();
}
