import { FileIcon } from "@phosphor-icons/react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { useViewListKeys, ViewRowBody, viewRowClass } from "./view-row.tsx";

function List(props: { current?: string }) {
  const keys = useViewListKeys<HTMLUListElement>();
  return (
    <>
      <button type="button">Before</button>
      <ul aria-label="Skills" {...keys}>
        {["code-review", "deploy", "docs", "lint"].map((name) => (
          <li key={name}>
            <a
              href={`#${name}`}
              className={viewRowClass}
              {...(props.current === name ? { "aria-current": "page" as const } : {})}
            >
              <ViewRowBody icon={FileIcon} title={name} />
            </a>
          </li>
        ))}
      </ul>
      <button type="button">After</button>
    </>
  );
}

const row = (name: string) => screen.getByRole("link", { name });

test("a view list is one Tab stop, entered at the current row", async () => {
  render(<List current="docs" />);
  screen.getByRole("button", { name: "Before" }).focus();
  await userEvent.tab();
  expect(document.activeElement).toBe(row("docs"));
  await userEvent.tab();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "After" }));
});

test("arrows, Home and End move between rows, and a letter jumps to the next row starting with it", async () => {
  render(<List />);
  screen.getByRole("button", { name: "Before" }).focus();
  await userEvent.tab();
  expect(document.activeElement).toBe(row("code-review"));
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(row("deploy"));
  await userEvent.keyboard("{End}");
  expect(document.activeElement).toBe(row("lint"));
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(row("lint"));
  await userEvent.keyboard("{Home}");
  expect(document.activeElement).toBe(row("code-review"));
  await userEvent.keyboard("d");
  expect(document.activeElement).toBe(row("deploy"));
  await userEvent.keyboard("d");
  expect(document.activeElement).toBe(row("docs"));
  await userEvent.keyboard("{ArrowUp}");
  expect(document.activeElement).toBe(row("deploy"));

  // Tab leaves from where the user is, and Shift+Tab comes back to the same row.
  await userEvent.tab();
  await userEvent.tab({ shift: true });
  expect(document.activeElement).toBe(row("deploy"));
});
