import type { FakeDaemon } from "../daemon.ts";

/**
 * Terminal, browser and preview state for the panels of a thread, matching the approved
 * design: a `tests` terminal that has already run the replay suite, a `zsh` terminal after
 * `git status`, the browser on the pairing page (driven by whichever agent of the thread has a
 * browser call running), and a detected dev server. Seeded into the daemon's own services, so
 * clients reach them over the wire exactly as they reach a real daemon's.
 */
export function seedPanels(
  daemon: FakeDaemon,
  threadId = "thread-cold-start",
  cwd = "/Users/dev/ace",
): void {
  const { terminals, browser } = daemon;
  const tests = terminals.openNow({ threadId, cwd, cols: 100, rows: 12, name: "tests" });
  terminals.write(tests.id, "bun run test\r");
  const zsh = terminals.openNow({ threadId, cwd, cols: 100, rows: 12, name: "zsh" });
  terminals.write(zsh.id, "git status --short\r");
  terminals.received.length = 0;
  browser.drive(threadId, {
    url: "localhost:5173/settings/devices",
    typed: "iPhone 16 Pro",
  });
  browser.serve(threadId, {
    port: 5173,
    origin: "http://localhost:5173",
    name: "web",
    source: "terminal",
  });
}
