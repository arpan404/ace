import type { BreakdownLine, UsageFilter } from "@ace/ui-core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, test } from "vitest";
import { useScrollLayout } from "@/test/scroll-layout.ts";
import { WhereItWent } from "./where-it-went.tsx";

useScrollLayout({ viewport: 600, row: 36 });

const pad = (n: number) => String(n).padStart(4, "0");
/** 2,000 automations, the costliest first. */
const automations: BreakdownLine[] = Array.from({ length: 2_000 }, (_, n) => ({
  key: `auto-${pad(n + 1)}`,
  tokens: 2_000 - n,
  usd: (2_000 - n) / 100,
}));

function Page() {
  const [filter, setFilter] = useState<UsageFilter>();
  return (
    <div className="overflow-y-auto">
      <WhereItWent
        lists={{ automation: automations }}
        metric="cost"
        money={(value) => `$${value.toFixed(2)}`}
        name={(_kind, key) => key.replace("auto-", "Automation ")}
        current={filter}
        onFilter={setFilter}
      />
    </div>
  );
}

const ranking = () => screen.getByRole("list", { name: "By automation" });

test("a full ranking of 2,000 automations mounts only a window, and End reaches the last", async () => {
  render(<Page />);
  expect(within(ranking()).getAllByRole("button")).toHaveLength(5);
  await userEvent.click(screen.getByRole("button", { name: "Show all 2000" }));
  await waitFor(() => expect(within(ranking()).getAllByRole("listitem").length).toBeGreaterThan(5));
  const rows = within(ranking()).getAllByRole("button");
  expect(rows.length).toBeLessThan(50);
  expect(within(ranking()).queryByRole("button", { name: /Automation 2000/ })).toBeNull();

  const first = within(ranking()).getByRole("button", { name: /Automation 0001/ });
  act(() => first.focus());
  fireEvent.keyDown(first, { key: "End" });
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(ranking()).getByRole("button", { name: /Automation 2000/ }),
    ),
  );
  // A row far down still filters the page.
  await userEvent.click(within(ranking()).getByRole("button", { name: /Automation 2000/ }));
  expect(
    within(ranking())
      .getByRole("button", { name: /Automation 2000/ })
      .getAttribute("aria-pressed"),
  ).toBe("true");
});
