import { render, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import type { LinkedPullRequest } from "@ace/protocol";
import { ThreadHoverPrs } from "./thread-hover-prs.tsx";

test("matching PR numbers in different repositories retain their own titles and states", () => {
  const prs: LinkedPullRequest[] = [
    {
      number: 42,
      repo: { forge: "github", host: "github.com", owner: "ace", name: "web" },
      url: "https://github.com/ace/web/pull/42",
      state: "merged",
      title: "Ship the web client",
      updatedAt: 1,
    },
    {
      number: 42,
      repo: { forge: "github", host: "github.com", owner: "ace", name: "daemon" },
      url: "https://github.com/ace/daemon/pull/42",
      state: "draft",
      title: "Prepare the daemon",
      updatedAt: 2,
    },
    {
      number: 43,
      repo: { forge: "github", host: "github.com", owner: "ace", name: "web" },
      url: "https://github.com/ace/web/pull/43",
      state: "open",
      title: "Fix reconnect",
      updatedAt: 3,
    },
  ];
  render(<ThreadHoverPrs prs={prs} />);
  const web = screen.getByRole("list", { name: "Pull requests in github.com/ace/web" });
  expect(
    within(web)
      .getAllByRole("listitem")
      .map((row) => row.getAttribute("aria-label")),
  ).toEqual(["#42, merged, Ship the web client", "#43, open, Fix reconnect"]);
  const daemon = screen.getByRole("list", { name: "Pull requests in github.com/ace/daemon" });
  expect(
    within(daemon)
      .getAllByRole("listitem")
      .map((row) => row.getAttribute("aria-label")),
  ).toEqual(["#42, draft, Prepare the daemon"]);
});
