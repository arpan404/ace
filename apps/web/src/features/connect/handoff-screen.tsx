import { Button } from "@/components/ui/button.tsx";

/**
 * A link asked to connect this window to a daemon it can't vouch for: one on another machine,
 * or one that would replace the token remembered here. Nothing is saved until the person agrees.
 * Rendered by the connection screen, which dismisses the boot splash.
 */
export function HandoffScreen(props: {
  url: string;
  reason: "elsewhere" | "replaces-remembered";
  onConnect(): void;
  onDecline(): void;
}) {
  return (
    <div className="relative grid h-full place-items-center overflow-auto p-6">
      <div className="wallpaper" />
      <main className="relative z-[1] w-full max-w-[420px] rounded-xl border border-border bg-reading p-7 shadow-glass">
        <p className="font-mono text-sm text-subtle-foreground">ace</p>
        <h1 className="mt-3 text-xl font-semibold tracking-title">Connect to this daemon?</h1>
        <p className="mt-1.5 text-ui leading-normal text-muted-foreground">
          A link asked ace to connect to{" "}
          <code className="rounded-[5px] bg-secondary px-1 text-[12px] break-all">{props.url}</code>
          .
        </p>
        <p className="mt-3 mb-6 text-ui leading-normal text-muted-foreground">
          {props.reason === "elsewhere"
            ? "It isn't on this computer. Everything you type in ace would go to it, so only connect if you started it yourself."
            : "Connecting replaces the token remembered on this device."}
        </p>
        <div className="flex gap-2">
          <Button variant="primary" onClick={props.onConnect}>
            Connect
          </Button>
          <Button onClick={props.onDecline}>Don't connect</Button>
        </div>
      </main>
    </div>
  );
}
