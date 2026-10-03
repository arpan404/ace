import { FakeBrowser } from "../browser.ts";
import { FakeTerminals } from "../terminals.ts";

/**
 * Terminal, browser and preview state for the panels of a thread, matching the approved
 * design: a `tests` terminal that has already run the replay suite, a `zsh` terminal after
 * `git status`, an agent driving the browser on the pairing page, and a detected dev server.
 */
export function panelServices(
  threadId = "thread-cold-start",
  cwd = "/Users/dev/ace",
): { terminals: FakeTerminals; browser: FakeBrowser } {
  const terminals = new FakeTerminals();
  const tests = terminals.openNow({ threadId, cwd, cols: 100, rows: 12, name: "tests" });
  terminals.write(tests.id, "bun run test\r");
  const zsh = terminals.openNow({ threadId, cwd, cols: 100, rows: 12 });
  terminals.write(zsh.id, "git status --short\r");
  terminals.received.length = 0;
  const browser = new FakeBrowser();
  browser.drive(threadId, {
    owner: "reconnect-audit",
    url: "localhost:5173/settings/devices",
    typed: "iPhone 16 Pro",
  });
  browser.serve(threadId, {
    port: 5173,
    origin: "http://localhost:5173",
    name: "web",
    source: "terminal",
  });
  return { terminals, browser };
}
