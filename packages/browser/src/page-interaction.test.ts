import { describe, expect, it } from "vitest";
import {
  emptyPageState,
  readPageReport,
  reducePage,
  type PageInteractionState,
} from "./page-interaction.ts";
import { pageBinding } from "./page-interaction-script.ts";

const call = (payload: unknown, name = pageBinding) => ({
  name,
  payload: typeof payload === "string" ? payload : JSON.stringify(payload),
});
const ids = () => {
  let next = 0;
  return () => `picker-${++next}`;
};
/** Folds page reports, as the page sends them, into the state clients receive. */
function fold(reports: unknown[], start: PageInteractionState = emptyPageState) {
  const id = ids();
  const sent: PageInteractionState["page"][] = [];
  let state = start;
  for (const payload of reports) {
    const report = readPageReport(call(payload));
    if (!report) continue;
    const next = reducePage(state, report, id);
    if (next !== state) sent.push(next.page);
    state = next;
  }
  return { state, sent };
}
const rect = { x: 10, y: 20, width: 200, height: 30 };

describe("page state for remote views", () => {
  it("ignores reports from any other binding and payloads that aren't reports", () => {
    expect(readPageReport(call({ kind: "cursor", cursor: "pointer" }, "__aceIdentity"))).toBe(
      undefined,
    );
    expect(readPageReport(call("{not json"))).toBe(undefined);
    expect(readPageReport(call({ kind: "unknown" }))).toBe(undefined);
    expect(readPageReport({ name: pageBinding })).toBe(undefined);
  });

  it("sends a cursor only when its shape changes", () => {
    const { sent } = fold([
      { kind: "cursor", cursor: "pointer" },
      { kind: "cursor", cursor: "pointer" },
      { kind: "cursor", cursor: "text" },
      { kind: "cursor", cursor: "default" },
      { kind: "cursor", cursor: "default" },
    ]);
    expect(sent).toEqual([{ cursor: "pointer" }, { cursor: "text" }, {}]);
  });

  it("reads a cursor it doesn't know as the default arrow", () => {
    const { state, sent } = fold([
      { kind: "cursor", cursor: "pointer" },
      { kind: "cursor", cursor: "url(evil.png)" },
    ]);
    expect(state.page.cursor).toBe(undefined);
    expect(sent).toEqual([{ cursor: "pointer" }, {}]);
  });

  it("follows the focused field and drops it when focus leaves", () => {
    const { sent } = fold([
      { kind: "focus", focus: { type: "email", rect, inputMode: "email" } },
      { kind: "focus", focus: { type: "email", rect, inputMode: "email" } },
      { kind: "focus", focus: null },
    ]);
    expect(sent).toEqual([{ focus: { type: "email", rect, inputMode: "email" } }, {}]);
  });

  it("names each opened picker so a late choice can't land in a newer one", () => {
    const select = {
      seq: 4,
      kind: "select",
      rect,
      value: "red",
      options: [
        { value: "red", label: "Red" },
        { value: "blue", label: "Blue", group: "Cool" },
      ],
    };
    const { state, sent } = fold([
      { kind: "picker", picker: select },
      { kind: "picker", picker: { ...select, seq: 5 } },
    ]);
    expect(sent.map((page) => page.picker?.pickerId)).toEqual(["picker-1", "picker-2"]);
    expect(state.pickerSeq).toBe(5);
    expect(state.page.picker).toEqual({
      pickerId: "picker-2",
      kind: "select",
      rect,
      value: "red",
      options: [
        { value: "red", label: "Red" },
        { value: "blue", label: "Blue", group: "Cool" },
      ],
    });
  });

  it("keeps a picker whose options partly don't fit, without those options", () => {
    const { state } = fold([
      {
        kind: "picker",
        picker: {
          seq: 1,
          kind: "select",
          rect,
          value: "a",
          options: [{ value: "a", label: "A" }, { value: "b" }, { value: "c", label: "C" }],
        },
      },
    ]);
    expect(state.page.picker?.options).toEqual([
      { value: "a", label: "A" },
      { value: "c", label: "C" },
    ]);
  });

  it("closes the tooltip when a picker opens, and the picker when the page says so", () => {
    const { state, sent } = fold([
      { kind: "tooltip", tooltip: { text: "Choose a colour", x: 5, y: 6 } },
      { kind: "picker", picker: { seq: 1, kind: "color", rect, value: "#ff0000" } },
      { kind: "picker", picker: null },
      { kind: "picker", picker: null },
    ]);
    expect(sent).toEqual([
      { tooltip: { text: "Choose a colour", x: 5, y: 6 } },
      {
        picker: { pickerId: "picker-1", kind: "color", rect, value: "#ff0000" },
      },
      {},
    ]);
    expect(state.pickerSeq).toBe(undefined);
  });

  it("keeps a date picker's bounds", () => {
    const { state } = fold([
      {
        kind: "picker",
        picker: { seq: 1, kind: "date", rect, value: "", min: "2026-01-01", max: "2026-12-31" },
      },
    ]);
    expect(state.page.picker).toMatchObject({ kind: "date", min: "2026-01-01", max: "2026-12-31" });
  });
});
