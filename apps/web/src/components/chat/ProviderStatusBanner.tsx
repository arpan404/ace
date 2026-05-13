import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "@ace/contracts";
import { memo, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const DISMISSED_PROVIDER_STATUS_KEYS_STORAGE_KEY = "ace:dismissed-provider-status-keys:v1";
const MAX_DISMISSED_PROVIDER_STATUS_KEYS = 128;

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

export function resolveProviderStatusDismissalKey(status: ServerProvider | null): string | null {
  if (!status || status.status === "ready" || status.status === "disabled") {
    return null;
  }
  return [
    status.provider,
    status.providerInstanceId ?? "default",
    status.status,
    status.auth.status,
    status.message ?? "",
  ].join(":");
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

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  status,
}: {
  status: ServerProvider | null;
}) {
  const [dismissedStatusKeys, setDismissedStatusKeys] = useState(() => {
    hydrateDismissedProviderStatusKeys();
    return new Set(dismissedProviderStatusKeys);
  });

  const statusKey = useMemo(() => resolveProviderStatusDismissalKey(status), [status]);

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

  return (
    <ProviderStatusOverlay>
      <Alert variant={status.status === "error" ? "error" : "warning"}>
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
        </AlertAction>
      </Alert>
    </ProviderStatusOverlay>
  );
});
