import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { expect, test } from "vitest";
import type { BrowserPageView, ForwardedInput } from "../sources.ts";
import { PageStateLayer } from "./page-state-layer.tsx";

const rect = { x: 40, y: 60, width: 200, height: 32 };

/** A live pane over a page, as the page view draws it, recording what goes to the page. */
function Pane(props: { page: BrowserPageView | undefined; sent: ForwardedInput[] }) {
  const pane = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  return (
    <div ref={pane} tabIndex={0} role="application" aria-label="Live page">
      <img ref={picture} alt="Live view" width={800} height={600} />
      <PageStateLayer
        page={props.page}
        pane={pane}
        picture={picture}
        frame={{ width: 800, height: 600 }}
        forward={(input) => props.sent.push(input)}
      />
    </div>
  );
}
function stage() {
  const sent: ForwardedInput[] = [];
  const view = render(<Pane page={undefined} sent={sent} />);
  const pane = screen.getByRole("application", { name: "Live page" });
  return {
    sent,
    pane,
    show: (page: BrowserPageView | undefined) =>
      act(() => view.rerender(<Pane page={page} sent={sent} />)),
    field: () => screen.getByLabelText<HTMLTextAreaElement>("Page text"),
  };
}
const select: BrowserPageView = {
  picker: {
    pickerId: "picker-1",
    kind: "select",
    rect,
    value: "red",
    options: [
      { value: "red", label: "Red", group: "Warm" },
      { value: "blue", label: "Blue" },
      { value: "grey", label: "Grey", disabled: true },
    ],
  },
};

test("choosing an option in the page's select sends that value to the page", async () => {
  const s = stage();
  s.pane.focus();
  s.show(select);
  await userEvent.click(await screen.findByRole("button", { name: "Blue" }));
  expect(s.sent).toEqual([{ kind: "pick", pickerId: "picker-1", values: ["blue"] }]);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Blue" })).toBeNull());
});

test("the page's current option is marked and a disabled one can't be chosen", async () => {
  const s = stage();
  s.pane.focus();
  s.show(select);
  expect((await screen.findByRole("button", { name: "Red" })).getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(screen.getByRole("button", { name: "Grey" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("Warm")).toBeTruthy();
});

test("closing the picker without a choice leaves the page's value as it was", async () => {
  const s = stage();
  s.pane.focus();
  s.show(select);
  await screen.findByRole("button", { name: "Blue" });
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(s.sent).toEqual([{ kind: "pick", pickerId: "picker-1" }]));
});

test("a picker opened while the person works elsewhere (an agent's click) stays closed", () => {
  const s = stage();
  const elsewhere = document.createElement("button");
  document.body.append(elsewhere);
  elsewhere.focus();
  s.show(select);
  expect(screen.queryByRole("button", { name: "Blue" })).toBeNull();
  elsewhere.remove();
});

test("a date is set from ace's own date field", async () => {
  const s = stage();
  s.pane.focus();
  s.show({ picker: { pickerId: "picker-2", kind: "date", rect, value: "2026-03-04" } });
  const day = await screen.findByLabelText("Choose a date");
  fireEvent.change(day, { target: { value: "2026-05-06" } });
  await userEvent.click(screen.getByRole("button", { name: "Set" }));
  expect(s.sent).toEqual([{ kind: "pick", pickerId: "picker-2", values: ["2026-05-06"] }]);
});

test("the page's title tooltip shows its text", () => {
  const s = stage();
  s.show({ tooltip: { text: "Saved two minutes ago", x: 100, y: 120 } });
  expect(screen.getByRole("tooltip").textContent).toBe("Saved two minutes ago");
});

test("the local field takes the keys while the page's field has focus, and gives them back", () => {
  const s = stage();
  s.pane.focus();
  s.show({ focus: { type: "email", rect } });
  expect(document.activeElement).toBe(s.field());
  expect(s.field().getAttribute("inputmode")).toBe("email");
  s.show({});
  expect(document.activeElement).toBe(s.pane);
});

test("a field an agent focuses while the person works elsewhere never takes their keys", () => {
  const s = stage();
  const composer = document.createElement("textarea");
  document.body.append(composer);
  composer.focus();
  s.show({ focus: { type: "text", rect } });
  expect(document.activeElement).toBe(composer);
  composer.remove();
});

test("IME composition shows marked in the page and commits as text", () => {
  const s = stage();
  s.pane.focus();
  s.show({ focus: { type: "textarea", rect } });
  const field = s.field();
  fireEvent.compositionStart(field, { data: "" });
  fireEvent.compositionUpdate(field, { data: "に" });
  field.value = "に";
  field.setSelectionRange(1, 1);
  fireEvent.input(field);
  fireEvent.compositionUpdate(field, { data: "にほん" });
  field.value = "にほん";
  field.setSelectionRange(3, 3);
  fireEvent.input(field);
  field.value = "日本";
  field.setSelectionRange(2, 2);
  fireEvent.compositionEnd(field, { data: "日本" });
  expect(s.sent).toEqual([
    { kind: "ime", text: "に", selectionStart: 1, selectionEnd: 1 },
    { kind: "ime", text: "にほん", selectionStart: 3, selectionEnd: 3 },
    { kind: "key", event: "char", key: "Unidentified", text: "日本" },
  ]);
});

test("autocorrect fixing the last word lands as the same fix in the page", () => {
  const s = stage();
  s.pane.focus();
  s.show({ focus: { type: "text", rect } });
  const field = s.field();
  const type = (value: string) => {
    field.value = value;
    field.setSelectionRange(value.length, value.length);
    fireEvent.input(field);
  };
  type("teh");
  type("teh ");
  type("the ");
  // The page's field, as the forwarded keys and text leave it.
  let page = "";
  for (const input of s.sent) {
    if (input.kind !== "key") continue;
    if (input.event === "char") page += input.text ?? "";
    else if (input.event === "keyDown" && input.key === "Backspace") page = page.slice(0, -1);
  }
  expect(page).toBe("the ");
});
