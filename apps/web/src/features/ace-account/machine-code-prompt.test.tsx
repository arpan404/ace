import { machineCodeGate } from "@ace/client";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { createTimeSource, TimeContext } from "@/lib/time.ts";
import { MachineCodePrompt } from "./machine-code-prompt.tsx";

function prompt(options: { lockedUntil?: number; now?: () => number } = {}) {
  const gate = machineCodeGate(async () => "grant");
  const onEntered = vi.fn();
  const time = createTimeSource(options.now ?? (() => 1_000_000));
  render(
    <TimeContext value={time}>
      <MachineCodePrompt
        gate={gate}
        machine="Studio"
        lockedUntil={options.lockedUntil}
        onEntered={onEntered}
      />
    </TimeContext>,
  );
  return { gate, onEntered };
}

test("asks for the code only while the machine wants it, and sends it with the next connection", async () => {
  const { gate, onEntered } = prompt();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByLabelText("Machine code")).toBeNull();
  act(() => gate.refused("machine_code_required"));
  expect(screen.getByRole("status").textContent).toBe("Enter Studio's machine code to open it.");
  await userEvent.type(screen.getByLabelText("Machine code"), "2468");
  await userEvent.click(screen.getByRole("button", { name: "Unlock" }));
  expect(onEntered).toHaveBeenCalled();
  expect(await gate.credential()).toEqual({ grant: "grant", machineCode: "2468" });
  // The prompt goes away once the code is on its way.
  expect(screen.queryByLabelText("Machine code")).toBeNull();
});

test("a wrong code says so and asks again", async () => {
  const { gate } = prompt();
  act(() => gate.refused("machine_code_wrong"));
  expect(screen.getByRole("status").textContent).toBe("That code didn't match. Try again.");
  expect(screen.getByLabelText("Machine code").hasAttribute("disabled")).toBe(false);
});

test("a locked machine says how long is left and takes no code until then", async () => {
  const { gate } = prompt({ lockedUntil: 1_000_000 + 14 * 60_000 + 5_000 });
  act(() => gate.refused("machine_code_locked"));
  expect(screen.getByRole("status").textContent).toBe(
    "Too many wrong codes. Try again in 15 minutes.",
  );
  expect(screen.getByLabelText("Machine code").hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Unlock" }).hasAttribute("disabled")).toBe(true);
});

test("a lock whose end has passed takes the code again", () => {
  const { gate } = prompt({ lockedUntil: 999_000 });
  act(() => gate.refused("machine_code_locked"));
  expect(screen.getByRole("status").textContent).toBe("Enter Studio's machine code to open it.");
  expect(screen.getByLabelText("Machine code").hasAttribute("disabled")).toBe(false);
});

test("a lock without a known end still says to wait", () => {
  const { gate } = prompt();
  act(() => gate.refused("machine_code_locked"));
  expect(screen.getByRole("status").textContent).toBe(
    "Too many wrong codes. Try again in a few minutes.",
  );
});

test("a code shorter than four characters is refused before it is sent", async () => {
  const { gate, onEntered } = prompt();
  act(() => gate.refused("machine_code_required"));
  await userEvent.type(screen.getByLabelText("Machine code"), "12");
  await userEvent.click(screen.getByRole("button", { name: "Unlock" }));
  expect(screen.getByRole("status").textContent).toBe("A machine code has at least 4 characters.");
  expect(onEntered).not.toHaveBeenCalled();
  expect(await gate.credential()).toEqual({ grant: "grant" });
});
