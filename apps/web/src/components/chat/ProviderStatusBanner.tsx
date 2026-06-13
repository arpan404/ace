import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "@ace/contracts";
import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { CircleAlertIcon, RefreshCwIcon, WrenchIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { resolveProviderStatusDismissalKey } from "./providerStatusDismissal";
import {
  GLASS_BANNER_CLASS_NAME,
  GLASS_BANNER_ERROR_CLASS_NAME,
  GLASS_BANNER_WARNING_CLASS_NAME,
} from "../ui/glass";

const DISMISSED_PROVIDER_STATUS_KEYS_STORAGE_KEY = "ace:dismissed-provider-status-keys:v1";
const MAX_DISMISSED_PROVIDER_STATUS_KEYS = 128;
const PROVIDER_STATUS_BANNER_SURFACE_BY_STATUS = {
  error: GLASS_BANNER_ERROR_CLASS_NAME,
  warning: GLASS_BANNER_WARNING_CLASS_NAME,
} as const;

let dismissedProviderStatusKeysHydrated = false;
const dismissedProviderStatusKeys = new Set<string>();

function canUseBrowserStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function hydrateDismissedProviderStatusKeys(): void {
  if (dismissedProviderStatusKeysHydrated) {
    return;
  }
  dismissedProviderStatusKeysHydrated = true;
  if (!canUseBrowserStorage()) {
    return;
  }

  try {
    const rawValue = window.localStorage.getItem(DISMISSED_PROVIDER_STATUS_KEYS_STORAGE_KEY);
    if (!rawValue) {
      return;
    }
    const parsedValue: unknown = JSON.parse(rawValue);
    if (!Array.isArray(parsedValue)) {
      return;
    }
    for (const key of parsedValue) {
      if (typeof key === "string" && key.length > 0) {
        dismissedProviderStatusKeys.add(key);
      }
    }
  } catch {
    // Invalid storage should never break the chat surface.
  }
}

function persistDismissedProviderStatusKeys(): void {
  if (!canUseBrowserStorage()) {
    return;
  }

  try {
    const keys = [...dismissedProviderStatusKeys].slice(-MAX_DISMISSED_PROVIDER_STATUS_KEYS);
    window.localStorage.setItem(DISMISSED_PROVIDER_STATUS_KEYS_STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // Storage is best-effort; the in-memory dismissal still applies for this session.
  }
}

function isProviderStatusDismissed(statusKey: string | null): boolean {
  if (statusKey === null) {
    return false;
  }
  hydrateDismissedProviderStatusKeys();
  return dismissedProviderStatusKeys.has(statusKey);
}

function dismissProviderStatus(statusKey: string): Set<string> {
  hydrateDismissedProviderStatusKeys();
  dismissedProviderStatusKeys.add(statusKey);
  persistDismissedProviderStatusKeys();
  return new Set(dismissedProviderStatusKeys);
}

function ProviderStatusOverlay({ children }: { children: ReactNode }) {
  if (typeof document === "undefined" || !document.body) {
    return null;
  }

  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 top-20 z-50 px-3">
      <div className="pointer-events-auto mx-auto max-w-3xl">{children}</div>
    </div>,
    document.body,
  );
}

export function ProviderStatusBanner({
  status,
  recoveryActionsEnabled = false,
  onOpenDiagnostics,
}: {
  status: ServerProvider | null;
  recoveryActionsEnabled?: boolean;
  onOpenDiagnostics?: () => void;
}) {
  const [dismissedStatusKeys, setDismissedStatusKeys] = useState(() => {
    hydrateDismissedProviderStatusKeys();
    return new Set(dismissedProviderStatusKeys);
  });
  const [refreshing, setRefreshing] = useState(false);

  const statusKey = resolveProviderStatusDismissalKey(status);

  if (!status || status.status === "ready" || status.status === "disabled") {
    return null;
  }

  if (
    statusKey !== null &&
    (dismissedStatusKeys.has(statusKey) || isProviderStatusDismissed(statusKey))
  ) {
    return null;
  }

  const providerLabel = PROVIDER_DISPLAY_NAMES[status.provider] ?? status.provider;
  const defaultMessage =
    status.status === "error"
      ? `${providerLabel} provider is unavailable.`
      : `${providerLabel} provider has limited availability.`;
  const title = `${providerLabel} provider status`;
  const bannerStatus = status.status === "error" ? "error" : "warning";
  const refresh = async () => {
    setRefreshing(true);
    try {
      await readNativeApi()?.server.refreshProviders();
      toastManager.add({
        type: "success",
        title: "Provider status refreshed",
        data: { dismissAfterVisibleMs: 3_000 },
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Provider refresh failed",
        description: error instanceof Error ? error.message : "Unable to refresh provider status.",
      });
      setRefreshing(false);
      return;
    }
    setRefreshing(false);
  };

  return (
    <ProviderStatusOverlay>
      <Alert
        className={cn(
          GLASS_BANNER_CLASS_NAME,
          PROVIDER_STATUS_BANNER_SURFACE_BY_STATUS[bannerStatus],
        )}
        variant={bannerStatus}
      >
        <CircleAlertIcon />
        <AlertTitle>{title}</AlertTitle>
        <Tooltip>
          <TooltipTrigger
            render={
              <AlertDescription className="line-clamp-3 text-[12px] leading-relaxed">
                {status.message ?? defaultMessage}
              </AlertDescription>
            }
          />
          <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
            {status.message ?? defaultMessage}
          </TooltipPopup>
        </Tooltip>
        <AlertAction>
          <div className="flex items-center gap-1">
            {recoveryActionsEnabled ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={refreshing}
                onClick={() => void refresh()}
              >
                <RefreshCwIcon className={refreshing ? "size-3 animate-spin" : "size-3"} />
                Refresh
              </Button>
            ) : null}
            {recoveryActionsEnabled && onOpenDiagnostics ? (
              <Button type="button" size="xs" variant="outline" onClick={onOpenDiagnostics}>
                <WrenchIcon className="size-3" />
                Details
              </Button>
            ) : null}
            <button
              type="button"
              aria-label="Dismiss provider status"
              className="inline-flex size-6 items-center justify-center rounded-lg text-destructive/50 transition-all duration-200 hover:bg-destructive/10 hover:text-destructive"
              onClick={() => {
                if (statusKey !== null) {
                  setDismissedStatusKeys(dismissProviderStatus(statusKey));
                }
              }}
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        </AlertAction>
      </Alert>
    </ProviderStatusOverlay>
  );
}
