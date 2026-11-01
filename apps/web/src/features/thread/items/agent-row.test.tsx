import { render, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { AgentRowContents } from "./agent-row.tsx";

const longModel = "Muse Spark 1.3 Contributor with an extremely long model suffix that overflows";
const meta = `Delegated · ${longModel} · XHigh`;

test("a delegated row in a narrow column keeps its status visible while its meta truncates with a tooltip", () => {
  const view = render(
    <div style={{ width: 360 }}>
      <div>
        <AgentRowContents
          mark={{ provider: "opencode" }}
          name="Relay protocol reference"
          meta={meta}
          state="working"
          stale={false}
          elapsed="1m 26s"
          detail="Writing"
          detailKind="live"
        />
      </div>
    </div>,
  );
  try {
    // The full meta stays available to assistive tech and hover even when it truncates.
    const metaEl = screen.getByTitle(meta);
    expect(metaEl.textContent).toContain("Delegated");
    // The status cluster stays whole and visible: never overlapped, never wrapped.
    expect(screen.getByText(/Running/).textContent).toContain("Running");
    expect(screen.getByText(/1m 26s/).textContent).toContain("1m 26s");
    // The second line reads what it does now.
    expect(screen.getByText("Writing").textContent).toBe("Writing");
  } finally {
    view.unmount();
  }
});

test("a done delegated child in a folded group keeps Done visible and truncates a long result URL", () => {
  const result =
    "PR: https://github.com/example/relay/pull/1593/with/a/very/long/path/that/keeps/going";
  const view = render(
    <div style={{ width: 360 }}>
      <ul aria-label="Subagents">
        <li>
          <div>
            <AgentRowContents
              mark={{ provider: "codex" }}
              name="Relay protocol reference"
              meta={meta}
              state="done"
              stale={false}
              elapsed="18m 55s"
              detail={result}
              detailKind="result"
            />
          </div>
        </li>
      </ul>
    </div>,
  );
  try {
    const list = screen.getByRole("list", { name: "Subagents" });
    const metaEl = within(list).getByTitle(meta);
    expect(metaEl.textContent).toContain("Delegated");
    expect(within(list).getByText(/Done/).textContent).toContain("Done");
    expect(within(list).getByText(/18m 55s/).textContent).toContain("18m 55s");
    // A long URL truncates instead of pushing the row wider, with the whole line in a tooltip.
    const detail = within(list).getByTitle(result);
    expect(detail.textContent).toContain("PR:");
  } finally {
    view.unmount();
  }
});

test("a delegated row on another machine keeps its status visible with the machine label", () => {
  const view = render(
    <div style={{ width: 360 }}>
      <div>
        <AgentRowContents
          mark={{ provider: "codex" }}
          name="Relay protocol reference"
          meta={meta}
          machine="MacBook Pro Rijan"
          state="working"
          stale={false}
          elapsed="1m 26s"
          detail="Writing"
          detailKind="live"
        />
      </div>
    </div>,
  );
  try {
    expect(screen.getByTitle("on MacBook Pro Rijan").textContent).toContain("MacBook Pro Rijan");
    expect(screen.getByTitle(meta).textContent).toContain("Delegated");
    expect(screen.getByText(/Running/).textContent).toContain("Running");
    expect(screen.getByText(/1m 26s/).textContent).toContain("1m 26s");
  } finally {
    view.unmount();
  }
});
