import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

const stored = (storage: ReturnType<typeof memoryKeyValue>) =>
  JSON.parse(storage.getItem("ace.editor.preferences") ?? "{}");

async function openPage(storage: ReturnType<typeof memoryKeyValue>) {
  await harness({ storage }).open("/settings/editor");
  await screen.findByRole("switch", { name: "Word wrap" });
  // The route's focus move to the title, so a click's focus isn't taken back.
  await waitFor(() => expect(document.activeElement?.tagName).toBe("H1"));
}

test("auto save is off until picked; after a pause offers how long to wait, kept on this device", async () => {
  const storage = memoryKeyValue();
  await openPage(storage);
  expect(screen.queryByText("Save after")).toBeNull();

  await userEvent.click(await screen.findByRole("button", { name: "After a pause" }));
  expect(await screen.findByText("Save after")).toBeTruthy();
  expect(stored(storage)).toMatchObject({ autoSave: "pause", autoSaveDelay: 1000 });

  await userEvent.click(screen.getByRole("button", { name: "When focus leaves" }));
  expect(stored(storage)).toMatchObject({ autoSave: "focus" });
  expect(screen.queryByText("Save after")).toBeNull();
});

test("text and display choices are stored together and read back on the next load", async () => {
  const storage = memoryKeyValue();
  await openPage(storage);
  await userEvent.click(screen.getByRole("button", { name: "Relaxed" }));
  await userEvent.click(screen.getByRole("button", { name: "Tabs" }));
  await userEvent.click(screen.getByRole("switch", { name: "Word wrap" }));
  const font = screen.getByRole("textbox", { name: "Font" });
  await userEvent.type(font, "Iosevka{Enter}");
  expect(stored(storage)).toMatchObject({
    lineSpacing: 2,
    insertSpaces: false,
    wordWrap: true,
    fontFamily: "Iosevka",
    indentGuides: true,
    stickyScroll: true,
  });

  document.body.innerHTML = "";
  await openPage(storage);
  expect(screen.getByRole("switch", { name: "Word wrap" }).getAttribute("aria-checked")).toBe(
    "true",
  );
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Font" }).value).toBe("Iosevka");
  const relaxed = screen.getByRole("button", { name: "Relaxed" });
  expect(relaxed.getAttribute("aria-pressed")).toBe("true");
});

test("a stored record with a value this build doesn't know keeps the values it does", async () => {
  const storage = memoryKeyValue();
  storage.setItem(
    "ace.editor.preferences",
    JSON.stringify({ autoSave: "sometimes", fontSize: 16, future: true }),
  );
  await openPage(storage);
  const off = within(screen.getByRole("group", { name: "Auto save" })).getByRole("button", {
    name: "Off",
  });
  expect(off.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("combobox", { name: "Font size" }).textContent).toContain("16px");
});
