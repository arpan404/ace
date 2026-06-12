"use client";

import { Toast } from "@base-ui/react/toast";
import { useEffect, type CSSProperties, type ReactNode } from "react";
import { useParams } from "@tanstack/react-router";
import { ThreadId } from "@ace/contracts";
import {
  CheckIcon,
  CircleAlertIcon,
  CopyIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { GLASS_TOOLTIP_CLASS_NAME } from "~/components/ui/glass";
import { cn } from "~/lib/utils";
import { buttonVariants } from "~/components/ui/buttonVariants";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import {
  buildVisibleToastLayout,
  selectLatestVisibleToast,
  shouldHideCollapsedToastContent,
} from "~/lib/ui/toast";

type ThreadToastData = {
  threadId?: ThreadId | null;
  tooltipStyle?: boolean;
  dismissAfterVisibleMs?: number;
  progressPercent?: number | null;
};

const toastManager = Toast.createToastManager<ThreadToastData>();
const anchoredToastManager = Toast.createToastManager<ThreadToastData>();
type ToastId = ReturnType<typeof toastManager.add>;
const threadToastVisibleTimeoutRemainingMs = new Map<ToastId, number>();

const TOAST_SURFACE_CLASS_NAME = cn(
  "toast-surface border text-popover-foreground",
  "overflow-hidden rounded-[calc(var(--panel-radius)+4px)] border-border/48",
  "shadow-[0_16px_44px_-28px_rgb(0_0_0/.42),0_1px_0_rgb(255_255_255/.14)_inset] ring-1 ring-foreground/[0.03]",
  "supports-[backdrop-filter]:backdrop-blur-xl supports-[backdrop-filter]:backdrop-saturate-[1.12]",
  "dark:border-border/44 dark:shadow-[0_18px_54px_-30px_rgb(0_0_0/.64),0_1px_0_rgb(255_255_255/.055)_inset]",
);
const TOAST_CONTENT_CLASS_NAME =
  "pointer-events-auto relative flex max-h-[min(7.5rem,calc(100dvh-1.5rem))] flex-col overflow-hidden px-3.5 py-2.5 text-xs";
const TOAST_TITLE_CLASS_NAME =
  "line-clamp-1 min-w-0 text-[13px] font-semibold leading-5 text-foreground/92 [overflow-wrap:anywhere]";
const TOAST_DESCRIPTION_CLASS_NAME =
  "line-clamp-2 min-w-0 select-text text-xs leading-4 text-muted-foreground/78 [overflow-wrap:anywhere]";
const TOAST_ACTION_CLASS_NAME =
  "h-7 max-w-[10rem] shrink-0 self-start truncate rounded-md border-border/50 bg-background/55 px-2.5 text-xs font-medium leading-none text-foreground/88 shadow-none hover:bg-accent/80 hover:text-accent-foreground supports-[backdrop-filter]:bg-background/35";
const TOAST_STATUS_ICONS = {
  error: CircleAlertIcon,
  loading: LoaderCircleIcon,
  warning: TriangleAlertIcon,
} as const;

function resolveToastProgressPercent(data: ThreadToastData | undefined): number | null {
  if (typeof data?.progressPercent !== "number" || !Number.isFinite(data.progressPercent)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(data.progressPercent)));
}

function ToastProgressBar({ percent }: { percent: number }) {
  return (
    <progress
      aria-label={`Progress ${percent}%`}
      className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted/50 accent-info [&::-moz-progress-bar]:rounded-full [&::-moz-progress-bar]:bg-info [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-muted/50 [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-info"
      max={100}
      value={percent}
    />
  );
}

function CopyErrorButton({ text }: { text: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            className="shrink-0 cursor-pointer rounded-md border border-transparent p-1 text-muted-foreground/72 transition-colors hover:border-border/60 hover:bg-background/70 hover:text-foreground"
            onClick={() => copyToClipboard(text)}
            type="button"
            aria-label={isCopied ? "Copied" : "Copy error"}
          />
        }
      >
        {isCopied ? (
          <CheckIcon className="size-3.5 text-success" />
        ) : (
          <CopyIcon className="size-3.5" />
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">{isCopied ? "Copied" : "Copy error"}</TooltipPopup>
    </Tooltip>
  );
}

function resolveToastStatusIcon(type: string | null | undefined) {
  if (type !== "error" && type !== "loading" && type !== "warning") {
    return null;
  }
  return TOAST_STATUS_ICONS[type];
}

function toastSurfaceClassName(type: string | null | undefined): string {
  return cn(
    TOAST_SURFACE_CLASS_NAME,
    type === "warning" &&
      "border-warning/45 shadow-warning/8 [--toast-surface-bg:color-mix(in_oklch,var(--popover)_88%,var(--warning)_12%)] dark:[--toast-surface-bg:color-mix(in_oklch,var(--popover)_76%,var(--warning)_24%)]",
    type === "error" &&
      "border-destructive/42 shadow-destructive/8 [--toast-surface-bg:color-mix(in_oklch,var(--popover)_90%,var(--destructive)_10%)] dark:[--toast-surface-bg:color-mix(in_oklch,var(--popover)_78%,var(--destructive)_22%)]",
    type === "loading" &&
      "border-info/38 shadow-info/8 [--toast-surface-bg:color-mix(in_oklch,var(--popover)_92%,var(--info)_8%)] dark:[--toast-surface-bg:color-mix(in_oklch,var(--popover)_82%,var(--info)_18%)]",
  );
}

function ToastStatusIcon({
  Icon,
  type,
}: {
  Icon: (typeof TOAST_STATUS_ICONS)[keyof typeof TOAST_STATUS_ICONS];
  type: keyof typeof TOAST_STATUS_ICONS;
}) {
  return (
    <span
      className={cn(
        "mt-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-lg border",
        type === "error" && "border-destructive/22 bg-destructive/8 text-destructive",
        type === "loading" && "border-info/22 bg-info/8 text-info",
        type === "warning" && "border-warning/22 bg-warning/8 text-warning",
      )}
      aria-hidden="true"
    >
      <Icon
        className={cn("size-[13px]", type === "loading" && "animate-spin")}
        strokeWidth={2.35}
      />
    </span>
  );
}

function ToastMessageContent({
  action,
  copyErrorText,
  progressPercent,
  statusIcon,
  statusType,
}: {
  action: ReactNode;
  copyErrorText: string | null;
  progressPercent: number | null;
  statusIcon: (typeof TOAST_STATUS_ICONS)[keyof typeof TOAST_STATUS_ICONS] | null;
  statusType: keyof typeof TOAST_STATUS_ICONS | null;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        {statusIcon && statusType ? <ToastStatusIcon Icon={statusIcon} type={statusType} /> : null}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <Toast.Title className={TOAST_TITLE_CLASS_NAME} data-slot="toast-title" />
            {copyErrorText ? <CopyErrorButton text={copyErrorText} /> : null}
          </div>
          <Toast.Description
            className={TOAST_DESCRIPTION_CLASS_NAME}
            data-slot="toast-description"
          />
          {progressPercent !== null ? <ToastProgressBar percent={progressPercent} /> : null}
        </div>
      </div>
      {action ? <div className="flex shrink-0 justify-end sm:pt-0.5">{action}</div> : null}
    </div>
  );
}

type ToastPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

interface ToastProviderProps extends Toast.Provider.Props {
  position?: ToastPosition;
}

function shouldRenderForActiveThread(
  data: ThreadToastData | undefined,
  activeThreadId: ThreadId | null,
): boolean {
  const toastThreadId = data?.threadId;
  if (!toastThreadId) return true;
  return toastThreadId === activeThreadId;
}

function useActiveThreadIdFromRoute(): ThreadId | null {
  return useParams({
    strict: false,
    select: (params) =>
      typeof params.threadId === "string" ? ThreadId.makeUnsafe(params.threadId) : null,
  });
}

function ThreadToastVisibleAutoDismiss({
  toastId,
  dismissAfterVisibleMs,
}: {
  toastId: ToastId;
  dismissAfterVisibleMs: number | undefined;
}) {
  useEffect(() => {
    if (!dismissAfterVisibleMs || dismissAfterVisibleMs <= 0) return;
    if (typeof window === "undefined" || typeof document === "undefined") return;

    let remainingMs = threadToastVisibleTimeoutRemainingMs.get(toastId) ?? dismissAfterVisibleMs;
    let startedAtMs: number | null = null;
    let timeoutId: number | null = null;
    let closed = false;

    const clearTimer = () => {
      if (timeoutId === null) return;
      window.clearTimeout(timeoutId);
      timeoutId = null;
    };

    const closeToast = () => {
      if (closed) return;
      closed = true;
      threadToastVisibleTimeoutRemainingMs.delete(toastId);
      toastManager.close(toastId);
    };

    const pause = () => {
      if (startedAtMs === null) return;
      remainingMs = Math.max(0, remainingMs - (Date.now() - startedAtMs));
      startedAtMs = null;
      clearTimer();
      threadToastVisibleTimeoutRemainingMs.set(toastId, remainingMs);
    };

    const start = () => {
      if (closed || startedAtMs !== null) return;
      if (remainingMs <= 0) {
        closeToast();
        return;
      }
      startedAtMs = Date.now();
      clearTimer();
      timeoutId = window.setTimeout(() => {
        remainingMs = 0;
        startedAtMs = null;
        closeToast();
      }, remainingMs);
    };

    const syncTimer = () => {
      const shouldRun = document.visibilityState === "visible" && document.hasFocus();
      if (shouldRun) {
        start();
        return;
      }
      pause();
    };

    syncTimer();
    document.addEventListener("visibilitychange", syncTimer);
    window.addEventListener("focus", syncTimer);
    window.addEventListener("blur", syncTimer);

    return () => {
      document.removeEventListener("visibilitychange", syncTimer);
      window.removeEventListener("focus", syncTimer);
      window.removeEventListener("blur", syncTimer);
      pause();
      clearTimer();
    };
  }, [dismissAfterVisibleMs, toastId]);

  return null;
}

function ToastProvider({ children, position = "top-center", ...props }: ToastProviderProps) {
  return (
    <Toast.Provider toastManager={toastManager} {...props}>
      {children}
      <Toasts position={position} />
    </Toast.Provider>
  );
}

function Toasts({ position = "top-center" }: { position: ToastPosition }) {
  const { toasts } = Toast.useToastManager<ThreadToastData>();
  const activeThreadId = useActiveThreadIdFromRoute();
  const isTop = position.startsWith("top");
  const visibleToasts = toasts.filter((toast) =>
    shouldRenderForActiveThread(toast.data, activeThreadId),
  );
  const visibleToastLayout = buildVisibleToastLayout(selectLatestVisibleToast(visibleToasts));

  useEffect(() => {
    const activeToastIds = new Set(toasts.map((toast) => toast.id));
    for (const toastId of threadToastVisibleTimeoutRemainingMs.keys()) {
      if (!activeToastIds.has(toastId)) {
        threadToastVisibleTimeoutRemainingMs.delete(toastId);
      }
    }
  }, [toasts]);

  return (
    <Toast.Portal data-slot="toast-portal">
      <Toast.Viewport
        className={cn(
          "fixed z-[70] mx-auto flex w-[calc(100%-var(--toast-inset)*2)] max-w-[26rem] [--toast-header-offset:0px] [--toast-inset:--spacing(2)] sm:[--toast-inset:--spacing(2.5)]",
          // Vertical positioning
          "data-[position*=top]:top-[calc(var(--toast-inset)+var(--toast-header-offset))]",
          "data-[position*=bottom]:bottom-(--toast-inset)",
          // Horizontal positioning
          "data-[position*=left]:left-(--toast-inset)",
          "data-[position*=right]:right-(--toast-inset)",
          "data-[position*=center]:-translate-x-1/2 data-[position*=center]:left-1/2",
        )}
        data-position={position}
        data-slot="toast-viewport"
        style={
          {
            "--toast-frontmost-height": `${visibleToastLayout.frontmostHeight}px`,
          } as CSSProperties
        }
      >
        {visibleToastLayout.items.map(({ toast, visibleIndex, offsetY }) => {
          const statusIcon = resolveToastStatusIcon(toast.type);
          const statusType =
            toast.type === "error" || toast.type === "loading" || toast.type === "warning"
              ? toast.type
              : null;
          const hideCollapsedContent = shouldHideCollapsedToastContent(
            visibleIndex,
            visibleToastLayout.items.length,
          );
          const progressPercent = resolveToastProgressPercent(toast.data);

          return (
            <Toast.Root
              className={cn(
                "absolute z-[calc(9999-var(--toast-index))] h-(--toast-calc-height) w-full select-none",
                toastSurfaceClassName(toast.type),
                "[transition:transform_.5s_cubic-bezier(.22,1,.36,1),opacity_.5s,height_.15s]",
                // Base positioning using data-position
                "data-[position*=right]:right-0 data-[position*=right]:left-auto",
                "data-[position*=left]:right-auto data-[position*=left]:left-0",
                "data-[position*=center]:right-0 data-[position*=center]:left-0",
                "data-[position*=top]:top-0 data-[position*=top]:bottom-auto data-[position*=top]:origin-top",
                "data-[position*=bottom]:top-auto data-[position*=bottom]:bottom-0 data-[position*=bottom]:origin-bottom",
                // Gap fill for hover
                "after:absolute after:left-0 after:h-[calc(var(--toast-gap)+1px)] after:w-full",
                "data-[position*=top]:after:top-full",
                "data-[position*=bottom]:after:bottom-full",
                "before:pointer-events-none before:absolute before:inset-x-4 before:top-0 before:h-px before:bg-foreground/8",
                "data-[type=error]:before:bg-destructive/35 data-[type=loading]:before:bg-info/35 data-[type=warning]:before:bg-warning/35",
                // Define some variables
                // Base UI exposes a shared front-most height for the collapsed stack.
                // If that shared measurement is briefly stale, long content can render
                // outside the card until hover expands the toast and swaps to its own height.
                "[--toast-calc-height:max(var(--toast-frontmost-height,var(--toast-height)),var(--toast-height))] [--toast-gap:--spacing(3)] [--toast-peek:--spacing(2.5)] [--toast-scale:calc(max(0,1-(var(--toast-index)*.06)))] [--toast-shrink:calc(1-var(--toast-scale))]",
                // Define offset-y variable
                "data-[position*=top]:[--toast-calc-offset-y:calc(var(--toast-offset-y)+var(--toast-index)*var(--toast-gap)+var(--toast-swipe-movement-y))]",
                "data-[position*=bottom]:[--toast-calc-offset-y:calc(var(--toast-offset-y)*-1+var(--toast-index)*var(--toast-gap)*-1+var(--toast-swipe-movement-y))]",
                // Default state transform
                "data-[position*=top]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)+(var(--toast-index)*var(--toast-peek))+(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
                "data-[position*=bottom]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--toast-peek))-(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
                // Limited state
                "data-limited:opacity-0",
                // Expanded state
                "data-expanded:h-(--toast-height)",
                "data-position:data-expanded:transform-[translateX(var(--toast-swipe-movement-x))_translateY(var(--toast-calc-offset-y))]",
                // Starting and ending animations
                "data-[position*=top]:data-starting-style:transform-[translateY(calc(-100%-var(--toast-inset)))]",
                "data-[position*=bottom]:data-starting-style:transform-[translateY(calc(100%+var(--toast-inset)))]",
                "data-[position*=top]:data-[position*=right]:data-starting-style:transform-[translateX(calc(100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:opacity-0",
                // Ending animations (direction-aware)
                "data-[position*=top]:data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateY(calc(-100%-var(--toast-inset)))]",
                "data-[position*=bottom]:data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateY(calc(100%+var(--toast-inset)))]",
                "data-[position*=top]:data-[position*=right]:data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateX(calc(100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
                "data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
                // Ending animations (expanded)
                "data-expanded:data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-expanded:data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-expanded:data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
                "data-expanded:data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
              )}
              data-position={position}
              data-type={toast.type ?? undefined}
              key={toast.id}
              style={
                {
                  "--toast-index": visibleIndex,
                  "--toast-offset-y": `${offsetY}px`,
                } as CSSProperties
              }
              swipeDirection={
                position.includes("center")
                  ? [isTop ? "up" : "down"]
                  : position.includes("left")
                    ? ["left", isTop ? "up" : "down"]
                    : ["right", isTop ? "up" : "down"]
              }
              toast={toast}
            >
              <ThreadToastVisibleAutoDismiss
                dismissAfterVisibleMs={toast.data?.dismissAfterVisibleMs}
                toastId={toast.id}
              />
              <Toast.Content
                className={cn(
                  TOAST_CONTENT_CLASS_NAME,
                  "transition-opacity duration-250 data-expanded:opacity-100",
                  hideCollapsedContent &&
                    "not-data-expanded:pointer-events-none not-data-expanded:opacity-0",
                )}
              >
                <ToastMessageContent
                  action={
                    toast.actionProps ? (
                      <Toast.Action
                        className={cn(
                          buttonVariants({ size: "sm", variant: "outline" }),
                          TOAST_ACTION_CLASS_NAME,
                        )}
                        data-slot="toast-action"
                      >
                        {toast.actionProps.children}
                      </Toast.Action>
                    ) : null
                  }
                  copyErrorText={
                    toast.type === "error" && typeof toast.description === "string"
                      ? toast.description
                      : null
                  }
                  progressPercent={progressPercent}
                  statusIcon={statusIcon}
                  statusType={statusType}
                />
              </Toast.Content>
            </Toast.Root>
          );
        })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

function AnchoredToastProvider({ children, ...props }: Toast.Provider.Props) {
  return (
    <Toast.Provider toastManager={anchoredToastManager} {...props}>
      {children}
      <AnchoredToasts />
    </Toast.Provider>
  );
}

function AnchoredToasts() {
  const { toasts } = Toast.useToastManager<ThreadToastData>();
  const activeThreadId = useActiveThreadIdFromRoute();
  const activeThreadToasts = toasts.flatMap((toast) =>
    shouldRenderForActiveThread(toast.data, activeThreadId) ? [toast] : [],
  );

  return (
    <Toast.Portal data-slot="toast-portal-anchored">
      <Toast.Viewport className="outline-none" data-slot="toast-viewport-anchored">
        {activeThreadToasts.map((toast) => {
          const tooltipStyle = toast.data?.tooltipStyle ?? false;
          const positionerProps = toast.positionerProps;
          const progressPercent = resolveToastProgressPercent(toast.data);
          const statusIcon = resolveToastStatusIcon(toast.type);
          const statusType =
            toast.type === "error" || toast.type === "loading" || toast.type === "warning"
              ? toast.type
              : null;

          if (!positionerProps?.anchor) {
            return null;
          }

          return (
            <Toast.Positioner
              className="z-[70] max-w-[min(--spacing(64),var(--available-width))]"
              data-slot="toast-positioner"
              key={toast.id}
              sideOffset={positionerProps.sideOffset ?? 4}
              toast={toast}
            >
              <Toast.Root
                className={cn(
                  "relative text-balance border text-popover-foreground text-xs transition-[scale,opacity] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0",
                  tooltipStyle ? GLASS_TOOLTIP_CLASS_NAME : toastSurfaceClassName(toast.type),
                )}
                data-slot="toast-popup"
                toast={toast}
              >
                {tooltipStyle ? (
                  <Toast.Content className="pointer-events-auto px-2 py-1">
                    <Toast.Title
                      className="line-clamp-2 max-w-64 text-xs leading-4 [overflow-wrap:anywhere]"
                      data-slot="toast-title"
                    />
                  </Toast.Content>
                ) : (
                  <Toast.Content className={TOAST_CONTENT_CLASS_NAME}>
                    <ToastMessageContent
                      action={
                        toast.actionProps ? (
                          <Toast.Action
                            className={cn(
                              buttonVariants({ size: "sm", variant: "outline" }),
                              TOAST_ACTION_CLASS_NAME,
                            )}
                            data-slot="toast-action"
                          >
                            {toast.actionProps.children}
                          </Toast.Action>
                        ) : null
                      }
                      copyErrorText={
                        toast.type === "error" && typeof toast.description === "string"
                          ? toast.description
                          : null
                      }
                      progressPercent={progressPercent}
                      statusIcon={statusIcon}
                      statusType={statusType}
                    />
                  </Toast.Content>
                )}
              </Toast.Root>
            </Toast.Positioner>
          );
        })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

export { ToastProvider, toastManager, AnchoredToastProvider };
