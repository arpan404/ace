import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { permissionOption, permissionOptions } from "@ace/ui-core";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { PermissionPicker } from "./permission-picker.tsx";

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
