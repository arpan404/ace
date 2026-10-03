/**
 * The desktop app's first paint while its daemon starts. A first start can take a while
 * (provider history is scanned before the daemon answers), so this is a calm wait, not an
 * error; the connection screen appears only if the desktop reports a real failure.
 */
export function StartingScreen() {
  return (
    <div className="relative grid h-full place-items-center p-6">
      <div className="wallpaper" />
      <p
        role="status"
        aria-live="polite"
        className="relative z-[1] font-mono text-sm text-subtle-foreground"
      >
        Starting ace…
      </p>
    </div>
  );
}
