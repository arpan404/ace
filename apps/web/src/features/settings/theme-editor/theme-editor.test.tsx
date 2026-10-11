import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { basePreset } from "@/theme/presets.ts";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

async function advanced() {
  await screen.findByRole("combobox", { name: "Theme to edit" });
  if (!screen.queryByRole("textbox", { name: "Window background" }))
    await userEvent.click(within(screen.getByRole("main")).getByText("Advanced", { exact: true }));
}
async function action(name: string) {
  await userEvent.click(await screen.findByRole("button", { name: "Theme actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name }));
}
const root = document.documentElement;
afterEach(() => {
  for (const name of ["data-theme", "data-scheme", "data-accent", "data-density", "style"])
    root.removeAttribute(name);
  document.getElementById("ace-themes")?.remove();
});

const appliedCss = () => document.getElementById("ace-themes")?.textContent ?? "";
const select = () => screen.getByRole("combobox", { name: "Theme to edit" });
const appliedTheme = () => root.getAttribute("data-theme") ?? "";
function valueOf(name: string): string {
  const field = screen.getByRole("textbox", { name });
  return field instanceof HTMLInputElement ? field.value : "";
}

async function setToken(name: string, value: string) {
  await advanced();
  const field = await screen.findByRole("textbox", { name });
  // These cases exercise draft validation and commit, not keyboard sequencing or the debounce.
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
}

test("editing a preset forks a custom copy, applies it live and lists it under Appearance", async () => {
  const storage = memoryKeyValue();
  await harness({ storage }).open("/settings/theme-editor");
  await advanced();
  await screen.findByRole("textbox", { name: "Window background" });
  expect(valueOf("Window background")).toBe("#0F0F0F");
  expect(screen.getByRole("textbox", { name: "Main column background" })).toBeTruthy();

  await setToken("Window background", "#123456");
  // A first visit follows the OS; editing pins the copy, and says so with Undo.
  expect(
    (await screen.findAllByText("Editing a copy of Dark · System theme turned off")).length,
  ).toBeGreaterThan(0);
  const forkId = appliedTheme();
  expect(forkId).toMatch(/^dark~/);
  expect(appliedCss()).toContain(`[data-theme="${forkId}"]{color-scheme:dark;--background:#123456`);
  // The preset itself is untouched.
  expect(appliedCss()).toContain('[data-theme="dark"]{color-scheme:dark;--background:#0F0F0F');
  expect(screen.getByRole("combobox", { name: "Theme to edit" }).textContent).toContain(
    "Dark custom (custom)",
  );
  await waitFor(() => expect(storage.getItem("ace.themes")).toContain("#123456"));

  await userEvent.click(screen.getByRole("link", { name: "Appearance", current: false }));
  expect((await screen.findByRole("combobox", { name: "Theme" })).textContent).toContain(
    "Dark custom",
  );
});

test("a value CSS would refuse is marked and never applied or stored", async () => {
  const storage = memoryKeyValue();
  await harness({ storage }).open("/settings/theme-editor");
  await setToken("Window background", "#1");
  const field = screen.getByRole("textbox", { name: "Window background" });
  await userEvent.tab();
  expect(field.getAttribute("aria-invalid")).toBe("true");
  expect(screen.getByText("Not a colour")).toBeTruthy();
  expect(appliedTheme()).not.toMatch(/~/);
  expect(storage.getItem("ace.themes") ?? "").not.toContain('"#1"');

  await setToken("Corner radius", "banana");
  await userEvent.tab();
  expect(screen.getByText("Use a length, like 10px")).toBeTruthy();
  expect(appliedCss()).not.toContain("banana");

  await setToken("Corner radius", "12px");
  await userEvent.tab();
  await waitFor(() => expect(appliedCss()).toContain("--radius:12px"));
});

test("the colour picker edits hex tokens; non-colour tokens have none", async () => {
  await harness().open("/settings/theme-editor");
  await advanced();
  // Native colour inputs report a full lowercase hex.
  fireEvent.input(await screen.findByLabelText("Pick Menu background"), {
    target: { value: "#334455" },
  });
  await waitFor(() => expect(valueOf("Menu background")).toBe("#334455"));
  expect(screen.queryByLabelText("Pick Corner radius")).toBeNull();
  expect(screen.getByLabelText("Pick Main column background")).toBeTruthy();
});

test("low-contrast text is warned about, and Reset to the preset clears it", async () => {
  await harness().open("/settings/theme-editor");
  await screen.findByRole("combobox", { name: "Theme to edit" });
  expect(screen.queryByText("Contrast looks good.")).toBeNull();

  await setToken("Secondary text", "#222222");
  expect(await screen.findByText("1 contrast warning")).toBeTruthy();
  expect(screen.getByText(/^Secondary text: 1\.\d\d:1; needs 4\.5:1\.$/)).toBeTruthy();

  await action("Reset to Dark");
  await screen.findByRole("combobox", { name: "Theme to edit" });
  expect(screen.queryByText("Contrast looks good.")).toBeNull();
  await waitFor(() => expect(screen.queryByText("1 contrast warning")).toBeNull());
  expect(valueOf("Secondary text")).toBe(basePreset("dark").tokens["--muted-foreground"]);
  // Reset keeps the custom theme; it does not switch back to the preset.
  expect(appliedTheme()).toMatch(/^dark~/);
});

test("duplicate, rename, then delete with undo", async () => {
  await harness().open("/settings/theme-editor");
  await action("Duplicate");
  await waitFor(() => expect(select().textContent).toContain("Dark copy (custom)"));
  // Presets offer no rename or delete; the copy does.
  await action("Rename");
  const name = await screen.findByRole("textbox", { name: "Theme name" });
  await userEvent.clear(name);
  await userEvent.type(name, "Studio night{Enter}");
  await waitFor(() => expect(select().textContent).toContain("Studio night (custom)"));

  const id = appliedTheme();
  await action("Delete");
  await waitFor(() => expect(appliedTheme()).toBe("dark"));
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  expect(appliedCss()).not.toContain(id);

  await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await waitFor(() => expect(appliedTheme()).toBe(id));
  expect(select().textContent).toContain("Studio night (custom)");
});

test("import accepts an ace theme file and refuses anything else", async () => {
  await harness().open("/settings/theme-editor");
  await advanced();
  const input = await screen.findByLabelText("Import theme file");
  const theme = { name: "Sea", scheme: "light", tokens: { "--background": "#E8F1F2" } };
  await userEvent.upload(
    input,
    new File([JSON.stringify(theme)], "sea.json", { type: "application/json" }),
  );
  expect(await screen.findByText("Imported Sea")).toBeTruthy();
  expect(appliedTheme()).toMatch(/^light~/);
  expect(root.getAttribute("data-scheme")).toBe("light");
  expect(valueOf("Window background")).toBe("#E8F1F2");
  // Tokens the file left out come from the Light preset.
  expect(valueOf("Menu background")).toBe("#FFFFFF");

  await userEvent.upload(input, new File(["{}"], "nope.json", { type: "application/json" }));
  expect((await screen.findAllByText("Couldn't import that theme")).length).toBeGreaterThan(0);
  expect(
    screen.getAllByText(
      "That file isn't an ace theme. Choose a file exported from the theme editor.",
    ).length,
  ).toBeGreaterThan(0);
  expect(appliedTheme()).toMatch(/^light~/);
});

test("export copies the theme on screen as an ace theme file", async () => {
  await harness().open("/settings/theme-editor");
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Theme actions" }));
  await user.click(await screen.findByRole("menuitem", { name: "Export" }));
  expect(await screen.findByText(/^Exported Dark · (File downloaded and )?copied$/)).toBeTruthy();
  const file = JSON.parse(await navigator.clipboard.readText()) as {
    name: string;
    scheme: string;
    tokens: Record<string, string>;
  };
  expect(file).toMatchObject({ name: "Dark", scheme: "dark" });
  expect(file.tokens["--background"]).toBe("#0F0F0F");
});
