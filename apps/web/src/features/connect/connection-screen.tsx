import { useDaemonConnection } from "@/boot/connection.tsx";
import { DaemonForm } from "./daemon-form.tsx";

/**
 * Shown when this window has no daemon to talk to. ace never runs providers itself: the
 * daemon on the person's machine drives their installed CLIs.
 */
export function ConnectionScreen() {
  const connection = useDaemonConnection();
  return (
    <div className="relative grid h-full place-items-center overflow-auto p-6">
      <div className="wallpaper" />
      <main className="relative z-[1] w-full max-w-[420px] rounded-xl border border-border bg-reading p-7 shadow-glass">
        <p className="font-mono text-sm text-subtle-foreground">ace</p>
        <h1 className="mt-3 text-xl font-semibold tracking-title">Connect to your daemon</h1>
        <p className="mt-1.5 mb-6 text-ui leading-normal text-muted-foreground">
          ace runs on your machine and drives the coding CLIs you already use. Start it with{" "}
          <code className="rounded-[5px] bg-secondary px-1 text-[12px]">ace start</code>, then point
          this window at it.
        </p>
        <DaemonForm
          url={connection.url}
          remembered={connection.remembered}
          submitLabel="Connect"
          onSubmit={connection.connect}
        />
      </main>
    </div>
  );
}
