import { CopyIcon } from "@phosphor-icons/react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useDismissBootSplash } from "@/lib/boot-splash.ts";
import { ConnectCard } from "./connect-card.tsx";

/** The words of a thrown value, for the person to read and copy. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/**
 * ace couldn't get as far as its shell: boot threw, or something under the connection gate
 * failed to render or load. Says what happened instead of leaving the splash up for good.
 */
export function BootFailure(props: {
  error: unknown;
  /** Forget the stored daemon and show the connection screen; absent where there is none. */
  onConnectionSettings?: (() => void) | undefined;
}) {
  useDismissBootSplash();
  const toast = useToast();
  const message = errorText(props.error);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      toast.add({ title: "Copied" });
    } catch {
      toast.add({ title: "Couldn't copy. Select the message and copy it yourself." });
    }
  };
  return (
    <ConnectCard labelledBy="boot-failure-title">
      <h1 id="boot-failure-title" className="mt-4 text-xl font-semibold tracking-title">
        ace couldn't start
      </h1>
      <p className="mt-1.5 text-ui leading-normal text-muted-foreground">
        Something went wrong before ace could open. Reloading usually fixes it.
      </p>
      <div className="relative mt-4 mb-6 rounded-md bg-secondary">
        <pre className="max-h-48 overflow-auto py-2.5 pr-9 pl-3 font-mono text-sm break-words whitespace-pre-wrap text-foreground">
          {message}
        </pre>
        <IconButton
          icon={CopyIcon}
          label="Copy error"
          size="sm"
          onClick={() => void copy()}
          className="absolute top-1.5 right-1.5"
        />
      </div>
      <div className="flex gap-2">
        <Button variant="primary" className="h-9 flex-1" onClick={() => location.reload()}>
          Reload
        </Button>
        {props.onConnectionSettings && (
          <Button className="h-9 flex-1" onClick={props.onConnectionSettings}>
            Connection settings…
          </Button>
        )}
      </div>
    </ConnectCard>
  );
}

/**
 * Catches what throws while the gate, the connection screen (or its chunk) or the shell
 * renders, so a failure shows `BootFailure` instead of a blank page or the endless splash.
 * Route errors inside the shell are the router's (`route-fallbacks.tsx`).
 */
export class BootErrorBoundary extends Component<
  { children: ReactNode; onConnectionSettings?: (() => void) | undefined },
  { error: { value: unknown } | undefined }
> {
  override state: { error: { value: unknown } | undefined } = { error: undefined };
  static getDerivedStateFromError(value: unknown) {
    return { error: { value } };
  }
  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("ace failed to render", error, info.componentStack);
  }
  override render() {
    if (this.state.error)
      return (
        <BootFailure
          error={this.state.error.value}
          onConnectionSettings={this.props.onConnectionSettings}
        />
      );
    return this.props.children;
  }
}
