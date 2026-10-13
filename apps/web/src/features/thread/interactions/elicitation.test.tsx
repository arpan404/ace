import { facts, type Scenario } from "@ace/fake-daemon";
import { ThreadId, type InteractionRequest } from "@ace/protocol";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { componentClient } from "@/test/component-client.tsx";
import { InteractionCard } from "./interaction-card.tsx";
import { answerStore } from "./answers.ts";

afterEach(() => answerStore.forgetAll());

async function open(request: InteractionRequest) {
  const scenario: Scenario = {
    thread: { id: "elicitation", workspaceId: "relay", provider: "claude", title: "Connect" },
    steps: [
      {
        kind: "facts",
        facts: [
          facts.rootAgent("claude"),
          facts.turn("root"),
          {
            type: "interaction.opened",
            agent: "root",
            interaction: "connect",
            blocking: true,
            request,
          },
        ],
      },
    ],
  };
  const app = await componentClient(scenario);
  const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("elicitation") });
  const interaction = view?.kind === "thread" ? Object.values(view.interactions)[0] : undefined;
  if (!interaction) throw new Error("Missing test request");
  app.render(<InteractionCard threadId="elicitation" interactionId={interaction.id} />);
  await screen.findByRole("button", { name: "Continue" });
  return app;
}

test("a required string, boolean and enum form sends entered values and prevents empty acceptance", async () => {
  const app = await open({
    kind: "elicitation",
    server: "projects",
    message: "Choose a project",
    mode: "form",
    schema: {
      type: "object",
      properties: {
        project: { type: "string", title: "Project" },
        approved: { type: "boolean", title: "Approved" },
        region: { type: "string", title: "Region", enum: ["us", "eu"] },
      },
      required: ["project", "approved", "region"],
    },
  });
  expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
  await userEvent.type(screen.getByRole("textbox", { name: "Project" }), "ace");
  await userEvent.click(screen.getByRole("combobox", { name: "Approved" }));
  await userEvent.click(await screen.findByRole("option", { name: "No" }));
  await userEvent.click(screen.getByRole("combobox", { name: "Region" }));
  await userEvent.click(await screen.findByRole("option", { name: "eu" }));
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() =>
    expect(app.daemon.resolution("elicitation", "connect")).toEqual({
      kind: "elicitation",
      action: "accept",
      content: { project: "ace", approved: false, region: "eu" },
    }),
  );
});

/** What a screen reader reads after a field's name: the text of the elements it is described by. */
function description(field: HTMLElement): string {
  return (field.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .map((id) => (id ? (document.getElementById(id)?.textContent ?? "") : ""))
    .join(" ")
    .trim();
}

test("a choice field cleared back to Choose is announced as invalid with its error text", async () => {
  await open({
    kind: "elicitation",
    server: "projects",
    message: "Choose a region",
    mode: "form",
    schema: {
      type: "object",
      properties: { region: { type: "string", title: "Region", enum: ["us", "eu"] } },
      required: ["region"],
    },
  });
  const region = screen.getByRole("combobox", { name: "Region" });
  expect(region.getAttribute("aria-invalid")).not.toBe("true");
  await userEvent.click(region);
  await userEvent.click(await screen.findByRole("option", { name: "eu" }));
  await userEvent.click(screen.getByRole("combobox", { name: "Region" }));
  await userEvent.click(await screen.findByRole("option", { name: "Choose…" }));
  const cleared = screen.getByRole("combobox", { name: "Region" });
  await waitFor(() => expect(cleared.getAttribute("aria-invalid")).toBe("true"));
  expect(description(cleared)).toBe("Region is required.");
  expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
});

test("URL consent exposes its supplied safe address independently of the message", async () => {
  const app = await open({
    kind: "elicitation",
    server: "projects",
    message: "Finish login",
    mode: "url",
    url: "https://example.com/consent",
  });
  expect(screen.getByRole("link", { name: "Open consent page" }).getAttribute("href")).toBe(
    "https://example.com/consent",
  );
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(app.daemon.resolution("elicitation", "connect")).toEqual({
      kind: "elicitation",
      action: "cancel",
    }),
  );
});

test.each([
  { mode: "form", schema: { type: "object", properties: { nested: { type: "object" } } } },
  { mode: "url", url: "javascript:alert(1)" },
] as const)("unsupported requests cannot accept and can be declined", async (request) => {
  const app = await open({
    kind: "elicitation",
    server: "projects",
    message: "Connect",
    ...request,
  });
  expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("alert").textContent).toMatch(/unsupported|safe/i);
  await userEvent.click(screen.getByRole("button", { name: "Decline" }));
  await waitFor(() =>
    expect(app.daemon.resolution("elicitation", "connect")).toEqual({
      kind: "elicitation",
      action: "decline",
    }),
  );
});
