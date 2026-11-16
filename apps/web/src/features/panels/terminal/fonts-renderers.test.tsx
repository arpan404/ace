import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fakeSuit } from "@/test/fake-suits.ts";
import { ThemeProvider } from "@/theme/theme-provider.tsx";
import type { TerminalSessions } from "./sessions.ts";
import { terminalLook } from "./suit-terminal.ts";
import { ScreenRows } from "./terminal-view.tsx";
import { XtermView } from "./xterm-view.tsx";

/** The options each xterm Terminal was created with. */
const created = vi.hoisted(() => [] as { fontFamily?: string }[]);

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}));
vi.mock("@xterm/xterm", () => {
  // Any member is a no-op that returns another no-op, so the view runs past construction.
  const inert: object = new Proxy(() => inert, {
    get: (_target, key) => (key === Symbol.toPrimitive ? () => 0 : inert),
    apply: () => inert,
  });
  return {
    Terminal: function Terminal(options: { fontFamily?: string }) {
      created.push(options);
      return inert;
    },
  };
});

const theme = document.createElement("style");
beforeEach(() => {
  // What the theme's `--font-mono` resolves to on the terminal's `font-mono` box.
  theme.textContent = '.font-mono { font-family: "SF Mono", ui-monospace, Menlo, monospace; }';
  document.head.append(theme);
  created.length = 0;
  // jsdom has no layout observers; the xterm view only fits itself with this one.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  theme.remove();
  vi.unstubAllGlobals();
});

const faces = (stack: string | undefined) =>
  (stack ?? "").split(",").map((face) => face.trim().replace(/"/g, ""));

function expectSymbolFallback(stack: string | undefined) {
  const list = faces(stack);
  expect(list[0]).toBe("SF Mono");
  expect(list).toContain("Symbols Nerd Font Mono");
  expect(list).toContain("ui-monospace");
  expect(list.indexOf("Symbols Nerd Font Mono")).toBeLessThan(list.indexOf("ui-monospace"));
}

test("the DOM terminal screen draws with the resolved monospace stack plus the symbol faces", () => {
  render(<ScreenRows rows={[]} label="zsh output" />);
  expectSymbolFallback(screen.getByRole("log", { name: "zsh output" }).style.fontFamily);
});

test("without WebGL the DOM terminal screen draws a Suit's terminal font, size and colours", () => {
  const crt = fakeSuit({
    id: "crt",
    dark: {},
    terminal: {
      fontFamily: "Courier New",
      fontSize: 16,
      lineHeight: 1.5,
      dark: { background: "#001100", foreground: "#33ff66" },
    },
  });
  const rows = [{ id: 1, segments: [{ text: "ok", style: {} }] }];
  const { rerender } = render(
    <ScreenRows rows={rows} label="zsh output" look={terminalLook(crt, "dark")} />,
  );
  const log = screen.getByRole("log", { name: "zsh output" });
  expect(faces(log.style.fontFamily)[0]).toBe("Courier New");
  expect(log.style.fontSize).toBe("16px");
  expect(log.style.lineHeight).toBe("24px");
  expect(log.style.color).toBe("rgb(51, 255, 102)");
  expect(log.style.backgroundColor).toBe("rgb(0, 17, 0)");
  // Back on ace's own look, the screen keeps the theme's text and the panel's background.
  rerender(<ScreenRows rows={rows} label="zsh output" look={terminalLook(null, "dark")} />);
  expect(log.style.color).toBe("");
  expect(log.style.backgroundColor).toBe("");
  expectSymbolFallback(log.style.fontFamily);
});

test("the xterm terminal is created with the resolved monospace stack plus the symbol faces", async () => {
  const sessions: Pick<TerminalSessions, "output" | "write" | "resize"> = {
    output: () => () => {},
    write: () => {},
    resize: () => {},
  };
  render(
    // No Suit is applied: the terminal looks as it does under a built-in theme.
    <ThemeProvider
      environment={{
        storage: { getItem: () => null, setItem() {}, removeItem() {} },
        root: document.createElement("div"),
      }}
    >
      <XtermView
        sessions={sessions as TerminalSessions}
        id="pty-1"
        name="zsh"
        onSurface={() => {}}
        readOnly={false}
        autoFocus={false}
        onFind={() => {}}
      />
    </ThemeProvider>,
  );
  await waitFor(() => expect(created).toHaveLength(1));
  expectSymbolFallback(created[0]?.fontFamily);
});
