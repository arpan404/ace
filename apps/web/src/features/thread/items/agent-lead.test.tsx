import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { ProvidersLead } from "./agent-lead.tsx";

const marks = (lead: HTMLElement) =>
  [...lead.querySelectorAll<HTMLElement>("[data-provider]")].map((mark) => mark.dataset.provider);

test("a group's lead shows each provider once, in launch order", () => {
  render(
    <ProvidersLead
      agents={[{ provider: "claude" }, { provider: "codex" }, { provider: "claude" }]}
    />,
  );
  const lead = screen.getByRole("img", { name: "Claude Code and Codex" });
  expect(marks(lead)).toEqual(["claude", "codex"]);
  expect(lead.textContent).toBe("");
});

test("past three providers the lead shows two marks and how many more", () => {
  render(
    <ProvidersLead
      agents={[
        { provider: "claude" },
        { provider: "codex" },
        { provider: "cursor" },
        { provider: "pi" },
      ]}
    />,
  );
  const lead = screen.getByRole("img", { name: "Claude Code, Codex and 2 more" });
  expect(marks(lead)).toEqual(["claude", "codex"]);
  expect(lead.textContent).toBe("+2");
});
