import { CopyIcon } from "@phosphor-icons/react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useDismissBootSplash } from "@/lib/boot-splash.ts";
import { ConnectCard } from "./connect-card.tsx";

/** The words of a thrown value, for the person to read and copy; never a daemon token. */
export function errorText(error: unknown): string {
  return redact(rawText(error));
}

function rawText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** Daemon and device tokens are 64 hex characters; a `token=` link carries one too. */
function redact(text: string): string {
  return text
    .replace(/(token=)[^&\s"']+/gi, "$1[hidden]")
    .replace(/\b[0-9a-f]{64}\b/gi, "[token hidden]");
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
      toast.error({ title: "Couldn't copy. Select the message and copy it yourself." });
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
 * Catches what throws below it and says ace couldn't start, instead of a blank page or the
 * endless splash. `AppFrame` puts a `bare` one outside its providers (`BareBootFailure`, which
 * needs none) and one inside them (`BootFailure`). Route errors inside the shell are the
 * router's.
 */
export class BootErrorBoundary extends Component<
  {
    children: ReactNode;
    /** Outside the providers: plain markup that needs no theme, tooltips or toasts. */
    bare?: boolean;
    onConnectionSettings?: (() => void) | undefined;
  },
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
    const error = this.state.error;
    if (!error) return this.props.children;
    if (this.props.bare) return <BareBootFailure error={error.value} />;
    return (
      <BootFailure error={error.value} onConnectionSettings={this.props.onConnectionSettings} />
    );
  }
}

/**
 * `BootFailure` for when the providers themselves failed (theme, tooltips, toasts) or the entry
 * never got as far as them: plain markup in system colours, light or dark with the OS.
 */
export function BareBootFailure(props: { error: unknown }) {
  useDismissBootSplash();
  const message = errorText(props.error);
  return (
    <div
      style={{
        colorScheme: "light dark",
        background: "Canvas",
        color: "CanvasText",
        font: "14px/1.5 system-ui, sans-serif",
        height: "100%",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <main
        aria-labelledby="bare-boot-failure-title"
        style={{ maxWidth: 420, width: "100%", display: "grid", gap: 12 }}
      >
        <h1 id="bare-boot-failure-title" style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>
          ace couldn't start
        </h1>
        <p style={{ margin: 0, opacity: 0.75 }}>
          Something went wrong before ace could open. Reloading usually fixes it.
        </p>
        <pre
          style={{
            margin: 0,
            padding: "10px 12px",
            borderRadius: 8,
            background: "color-mix(in srgb, CanvasText 8%, Canvas)",
            font: "12.5px/1.45 ui-monospace, monospace",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            maxHeight: 192,
            overflow: "auto",
          }}
        >
          {message}
        </pre>
        <button
          type="button"
          onClick={() => location.reload()}
          style={{ justifySelf: "start", font: "inherit", padding: "6px 14px", borderRadius: 8 }}
        >
          Reload
        </button>
      </main>
    </div>
  );
}
