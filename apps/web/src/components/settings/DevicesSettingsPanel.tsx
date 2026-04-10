import { LaptopIcon, LinkIcon, ScanLineIcon, Trash2Icon } from "lucide-react";
import QRCode from "qrcode";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  buildPairingPayload,
  createHostPairingSession,
  buildHostSharePayload,
  connectToWsHost,
  createRemoteHostInstance,
  isHostConnectionActive,
  loadRemoteHostInstances,
  normalizeWsUrl,
  parseHostConnectionQrPayload,
  requestPairingClaim,
  resolveHostPairingSession,
  readHostPairingSession,
  persistRemoteHostInstances,
  resolveActiveWsUrl,
  resolveHostConnectionWsUrl,
  resolveLocalDeviceWsUrl,
  splitWsUrlAuthToken,
  waitForPairingApproval,
  type RemoteHostInstance,
  type HostPairingSessionStatus,
} from "../../lib/remoteHosts";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";
import { isElectron } from "../../env";

interface HostDraftState {
  readonly name: string;
  readonly wsUrl: string;
  readonly authToken: string;
}

const EMPTY_HOST_DRAFT: HostDraftState = {
  name: "",
  wsUrl: "",
  authToken: "",
};

interface PairingSessionState {
  readonly sessionId: string;
  readonly secret: string;
  readonly claimUrl: string;
  readonly status: HostPairingSessionStatus["status"];
  readonly expiresAt: string;
  readonly requesterName?: string;
  readonly claimId?: string;
}

const URL_MODE_MAX_HOSTS = 1;

function normalizeHostsForMode(hosts: ReadonlyArray<RemoteHostInstance>, desktopMode: boolean) {
  if (desktopMode) {
    return [...hosts];
  }
  return hosts.slice(0, URL_MODE_MAX_HOSTS);
}

export function DevicesSettingsPanel() {
  const desktopMode = isElectron;
  const [hosts, setHosts] = useState<RemoteHostInstance[]>(() =>
    normalizeHostsForMode(loadRemoteHostInstances(), desktopMode),
  );
  const [hostDraft, setHostDraft] = useState<HostDraftState>(EMPTY_HOST_DRAFT);
  const [importPayload, setImportPayload] = useState("");
  const [importingPairing, setImportingPairing] = useState(false);
  const [pairingSession, setPairingSession] = useState<PairingSessionState | null>(null);
  const [creatingPairingSession, setCreatingPairingSession] = useState(false);
  const [resolvingPairingSession, setResolvingPairingSession] = useState(false);
  const [pairingQrDataUrl, setPairingQrDataUrl] = useState<string | null>(null);
  const activeWsUrl = useMemo(() => resolveActiveWsUrl(), []);
  const localDeviceConnection = useMemo(() => splitWsUrlAuthToken(resolveLocalDeviceWsUrl()), []);
  const localConnectionUrl = useMemo(
    () => resolveHostConnectionWsUrl(localDeviceConnection),
    [localDeviceConnection],
  );
  const localIsActive = useMemo(
    () => localConnectionUrl === activeWsUrl,
    [activeWsUrl, localConnectionUrl],
  );
  const pairingPayload = useMemo(() => {
    if (!pairingSession) {
      return "";
    }
    try {
      return buildPairingPayload({
        name: "Primary ace host",
        sessionId: pairingSession.sessionId,
        secret: pairingSession.secret,
        claimUrl: pairingSession.claimUrl,
      });
    } catch {
      return "";
    }
  }, [pairingSession]);

  const saveHosts = useCallback(
    (nextHosts: RemoteHostInstance[]) => {
      const normalizedHosts = normalizeHostsForMode(nextHosts, desktopMode);
      setHosts(normalizedHosts);
      persistRemoteHostInstances(normalizedHosts);
    },
    [desktopMode],
  );

  useEffect(() => {
    if (!pairingPayload) {
      setPairingQrDataUrl(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(pairingPayload, {
      margin: 1,
      width: 220,
    })
      .then((dataUrl: string) => {
        if (!cancelled) {
          setPairingQrDataUrl(dataUrl);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPairingQrDataUrl(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pairingPayload]);

  const { copyToClipboard, isCopied } = useCopyToClipboard<{ readonly label: string }>({
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
        title: "Invalid pairing payload.",
        description: "Provide a ws/http URL, host:port, ace:// URL, or JSON payload.",
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
          title: "Payload imported.",
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Invalid host URL in payload.",
          description: error instanceof Error ? error.message : "Could not parse host payload.",
        });
      }
      return;
    }

    setImportingPairing(true);
    try {
      const receipt = await requestPairingClaim(parsed.pairing, {
        requesterName: desktopMode ? "ace desktop" : "ace web",
      });
      toastManager.add({
        type: "info",
        title: "Pairing request sent.",
        description: "Approve this request on the host device.",
      });
      const approvedDraft = await waitForPairingApproval(receipt);
      const { wsUrl, authToken: embeddedAuthToken } = splitWsUrlAuthToken(
        normalizeWsUrl(approvedDraft.wsUrl),
      );
      upsertHost({
        name: approvedDraft.name ?? parsed.pairing.name ?? "",
        wsUrl,
        authToken: approvedDraft.authToken?.trim() || embeddedAuthToken,
      });
      setHostDraft(EMPTY_HOST_DRAFT);
      setImportPayload("");
      toastManager.add({
        type: "success",
        title: "Pairing approved.",
        description: "Remote host saved.",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Pairing failed.",
        description: error instanceof Error ? error.message : "Could not complete host pairing.",
      });
    } finally {
      setImportingPairing(false);
    }
  }, [desktopMode, importPayload, upsertHost]);

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
    connectToWsHost(localConnectionUrl);
  }, [localConnectionUrl]);

  const startPairingSession = useCallback(async () => {
    setCreatingPairingSession(true);
    try {
      const created = await createHostPairingSession({
        wsUrl: localDeviceConnection.wsUrl,
        authToken: localDeviceConnection.authToken,
        name: "Primary ace host",
      });
      setPairingSession({
        sessionId: created.sessionId,
        secret: created.secret,
        claimUrl: created.claimUrl,
        status: created.status,
        expiresAt: created.expiresAt,
      });
      toastManager.add({
        type: "success",
        title: "Pairing session ready.",
        description: "Scan the QR code from another device to request access.",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not start pairing session.",
        description: error instanceof Error ? error.message : "Pairing API request failed.",
      });
    } finally {
      setCreatingPairingSession(false);
    }
  }, [localDeviceConnection.authToken, localDeviceConnection.wsUrl]);

  const resolvePairingRequest = useCallback(
    async (approve: boolean) => {
      if (!pairingSession) {
        return;
      }
      setResolvingPairingSession(true);
      try {
        const updated = await resolveHostPairingSession({
          wsUrl: localDeviceConnection.wsUrl,
          authToken: localDeviceConnection.authToken,
          sessionId: pairingSession.sessionId,
          approve,
        });
        setPairingSession((previous) =>
          previous
            ? {
                ...previous,
                status: updated.status,
                expiresAt: updated.expiresAt,
                ...(updated.requesterName ? { requesterName: updated.requesterName } : {}),
                ...(updated.claimId ? { claimId: updated.claimId } : {}),
              }
            : previous,
        );
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not resolve pairing request.",
          description: error instanceof Error ? error.message : "Pairing resolution failed.",
        });
      } finally {
        setResolvingPairingSession(false);
      }
    },
    [localDeviceConnection.authToken, localDeviceConnection.wsUrl, pairingSession],
  );

  useEffect(() => {
    if (!pairingSession) {
      return;
    }
    if (
      pairingSession.status === "approved" ||
      pairingSession.status === "rejected" ||
      pairingSession.status === "expired"
    ) {
      return;
    }
    let cancelled = false;
    const handle = setInterval(() => {
      void readHostPairingSession({
        wsUrl: localDeviceConnection.wsUrl,
        authToken: localDeviceConnection.authToken,
        sessionId: pairingSession.sessionId,
      })
        .then((nextStatus) => {
          if (cancelled) {
            return;
          }
          setPairingSession((previous) =>
            previous
              ? {
                  ...previous,
                  status: nextStatus.status,
                  expiresAt: nextStatus.expiresAt,
                  ...(nextStatus.requesterName ? { requesterName: nextStatus.requesterName } : {}),
                  ...(nextStatus.claimId ? { claimId: nextStatus.claimId } : {}),
                }
              : previous,
          );
        })
        .catch(() => {
          if (!cancelled) {
            setPairingSession(null);
          }
        });
    }, 1_200);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [localDeviceConnection.authToken, localDeviceConnection.wsUrl, pairingSession]);

  return (
    <SettingsPageContainer>
      <SettingsSection title="Host this device" icon={<LaptopIcon className="size-3.5" />}>
        <SettingsRow
          title="Local ace host endpoint"
          description="Share this host with mobile/desktop clients. If clients are on other devices, bind your server to a LAN interface (for example 0.0.0.0)."
          status={
            <>
              <span className="block break-all font-mono text-[11px] text-foreground">
                {localDeviceConnection.wsUrl}
              </span>
              <span className="mt-1 block">
                {localDeviceConnection.authToken
                  ? "Auth token is gated by pairing approval."
                  : "No auth token configured."}
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
                onClick={() => copyToClipboard(localConnectionUrl, { label: "Host URL" })}
              >
                <LinkIcon className="size-3.5" />
                Copy URL
              </Button>
            </div>
          }
        />
        <SettingsRow
          title="Two-way QR pairing"
          description="Create a short-lived pairing QR. New devices request access, then you approve or reject here."
          control={
            <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  void startPairingSession();
                }}
                disabled={creatingPairingSession}
              >
                {creatingPairingSession
                  ? "Creating…"
                  : pairingSession
                    ? "Refresh session"
                    : "Start pairing"}
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => copyToClipboard(pairingPayload, { label: "Pairing payload" })}
                disabled={pairingPayload.length === 0}
              >
                {isCopied ? "Copied" : "Copy payload"}
              </Button>
            </div>
          }
        >
          {pairingSession ? (
            <div className="mt-3 grid gap-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                <div className="w-fit rounded-md border border-border/60 bg-background p-2">
                  {pairingQrDataUrl ? (
                    <img
                      src={pairingQrDataUrl}
                      alt="Pairing QR code"
                      className="size-40 rounded-sm bg-white p-1"
                    />
                  ) : (
                    <div className="flex size-40 items-center justify-center text-[11px] text-muted-foreground">
                      Preparing QR…
                    </div>
                  )}
                </div>
                <div className="min-w-0 space-y-1 text-xs text-muted-foreground">
                  <p>
                    Status: <span className="text-foreground">{pairingSession.status}</span>
                  </p>
                  <p>
                    Expires:{" "}
                    <span className="text-foreground">
                      {formatRelativeTimeLabel(pairingSession.expiresAt)}
                    </span>
                  </p>
                  {pairingSession.requesterName ? (
                    <p>
                      Requester:{" "}
                      <span className="text-foreground">{pairingSession.requesterName}</span>
                    </p>
                  ) : null}
                  {pairingSession.status === "claim-pending" ? (
                    <div className="flex gap-2 pt-2">
                      <Button
                        size="xs"
                        onClick={() => {
                          void resolvePairingRequest(true);
                        }}
                        disabled={resolvingPairingSession}
                      >
                        Approve
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => {
                          void resolvePairingRequest(false);
                        }}
                        disabled={resolvingPairingSession}
                      >
                        Reject
                      </Button>
                    </div>
                  ) : null}
                </div>
              </div>
              <Textarea
                className="min-h-20 font-mono text-[11px] leading-relaxed"
                value={pairingPayload}
                readOnly
              />
            </div>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">
              No active pairing session. Start one to generate a QR payload.
            </p>
          )}
        </SettingsRow>
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
              onChange={(event) =>
                setHostDraft((previous) => ({ ...previous, name: event.currentTarget.value }))
              }
              placeholder="Host name (optional)"
            />
            <Input
              value={hostDraft.wsUrl}
              onChange={(event) =>
                setHostDraft((previous) => ({ ...previous, wsUrl: event.currentTarget.value }))
              }
              placeholder="ws://192.168.x.x:3773/ws"
            />
            <Input
              type="password"
              value={hostDraft.authToken}
              onChange={(event) =>
                setHostDraft((previous) => ({ ...previous, authToken: event.currentTarget.value }))
              }
              placeholder="Auth token (optional)"
            />
          </div>
          <div className="mt-3 grid gap-2">
            <Textarea
              className="min-h-20 font-mono text-[11px] leading-relaxed"
              value={importPayload}
              onChange={(event) => setImportPayload(event.currentTarget.value)}
              placeholder="Paste ace:// URL, ws/http URL, host:port, or JSON payload from another device"
            />
            <div className="flex justify-end">
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  void importHostPayload();
                }}
                disabled={importingPairing}
              >
                {importingPairing ? "Waiting approval…" : "Import payload"}
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
            const sharePayload = buildHostSharePayload({
              name: host.name,
              wsUrl: host.wsUrl,
              authToken: host.authToken,
            });
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
                      onClick={() => copyToClipboard(sharePayload, { label: "Pairing payload" })}
                    >
                      Copy payload
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
