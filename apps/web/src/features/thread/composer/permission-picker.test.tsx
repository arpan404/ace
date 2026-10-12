import { configure, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { permissionOption, permissionOptions } from "@ace/ui-core";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { PermissionPicker } from "./permission-picker.tsx";

configure({ asyncUtilTimeout: 10_000 });

const native = {
  modes: ["inspect", "execute"],
  permissionModes: [
    {
      id: "inspect",
      label: "Inspect project",
      description: "Explore without changing files.",
      risk: "low" as const,
    },
    {
      id: "execute",
      label: "Execute plan",
      description: "Apply the reviewed plan.",
      risk: "medium" as const,
    },
  ],
  nativeAutoReview: false,
  toolGate: false,
};

test("an agent's own names and descriptions stay selectable without ace presets", async () => {
  const selected: (string | null)[] = [];
  render(
    <TooltipProvider delay={0}>
      <PermissionPicker
        current={permissionOption("inspect", native)}
        menu={{ options: permissionOptions(native), value: "inspect", loading: false }}
        onChange={(id) => selected.push(id)}
      />
    </TooltipProvider>,
  );
  const trigger = screen.getByRole("button", { name: "Approvals: Inspect project" });
  await userEvent.hover(trigger);
  expect(await screen.findByRole("tooltip")).toHaveProperty(
    "textContent",
    "Approvals: Inspect project · Explore without changing files.",
  );
  await userEvent.click(trigger);
  const execute = await screen.findByRole("menuitemradio", { name: "Execute plan" });
  await userEvent.hover(execute);
  expect(await screen.findByText("Apply the reviewed plan.")).toBeTruthy();
  await userEvent.click(execute);
  expect(selected).toEqual(["execute"]);
  await userEvent.click(trigger);
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Provider default" }));
  expect(selected).toEqual(["execute", null]);
});

test("loading capabilities uses a short label with the reason in the tooltip", async () => {
  render(
    <TooltipProvider delay={0}>
      <PermissionPicker
        current={permissionOption(null)}
        menu={{ options: [], value: undefined, loading: true }}
        onChange={() => {}}
      />
    </TooltipProvider>,
  );
  const trigger = screen.getByRole("button", { name: "Approvals: Approvals…" });
  expect(trigger.textContent).toBe("Approvals…");
  await userEvent.hover(trigger);
  expect(await screen.findByRole("tooltip")).toHaveProperty(
    "textContent",
    "Approvals… · Loading provider permission modes…",
  );
});

test("a failed capability read keeps the reason out of the compact label", async () => {
  const reason = "Couldn't load permission modes. Reconnect and try again.";
  render(
    <TooltipProvider delay={0}>
      <PermissionPicker
        current={permissionOption(null)}
        menu={{ options: [], value: undefined, loading: false, unavailable: reason }}
        onChange={() => {}}
      />
    </TooltipProvider>,
  );
  const trigger = screen.getByRole("button", { name: "Approvals: Approvals" });
  expect(trigger.textContent).toBe("Approvals");
  await userEvent.hover(trigger);
  expect(await screen.findByRole("tooltip")).toHaveProperty("textContent", reason);
});

test("Full access selects the unchanged native id and switching catalogs removes unsupported choices", async () => {
  const full = {
    ...native,
    permissionModes: [
      {
        id: "yolo",
        label: "YOLO",
        description: "Native tool auto-approval",
        risk: "high" as const,
        presentation: "full-access" as const,
      },
    ],
  };
  const selected: (string | null)[] = [];
  const view = (catalog: typeof native | typeof full, id: string) => (
    <TooltipProvider delay={0}>
      <PermissionPicker
        current={permissionOption(id, catalog)}
        menu={{ options: permissionOptions(catalog), value: id, loading: false }}
        onChange={(next) => selected.push(next)}
      />
    </TooltipProvider>
  );
  const rendered = render(view(full, "yolo"));
  await userEvent.click(screen.getByRole("button", { name: "Approvals: Full access" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Full access" }));
  expect(selected).toEqual(["yolo"]);
  rendered.rerender(view(native, "yolo"));
  await userEvent.click(screen.getByRole("button", { name: "Approvals: Unavailable mode: yolo" }));
  expect(screen.queryByRole("menuitemradio", { name: "Full access" })).toBeNull();
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Execute plan" }));
  expect(selected).toEqual(["yolo", "execute"]);
});

test("provider default has an icon-only trigger with its name and mode choices still reachable", async () => {
  const selected: (string | null)[] = [];
  render(
    <TooltipProvider delay={0}>
      <PermissionPicker
        current={permissionOption(null, native)}
        menu={{ options: permissionOptions(native), value: "", loading: false }}
        onChange={(id) => selected.push(id)}
      />
    </TooltipProvider>,
  );
  const trigger = screen.getByRole("button", { name: "Approvals: Provider default" });
  expect(trigger.textContent).toBe("");
  trigger.focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Inspect project" }));
  expect(selected).toEqual(["inspect"]);
});

test("a non-default pending permission keeps its label and application timing", () => {
  render(
    <TooltipProvider>
      <PermissionPicker
        current={permissionOption(null, native)}
        next={permissionOption("execute", native)}
        note="Applies at the agent's next turn"
        menu={{ options: permissionOptions(native), value: "execute", loading: false }}
        onChange={() => {}}
      />
    </TooltipProvider>,
  );
  const trigger = screen.getByRole("button", {
    name: "Approvals: Execute plan, applies at the agent's next turn",
  });
  expect(trigger.textContent).toBe("Execute plan");
});
