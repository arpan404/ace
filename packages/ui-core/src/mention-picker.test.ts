import { expect, it } from "vitest";
import {
  agentDetail,
  bestRow,
  clubDetail,
  deviceDetail,
  pickerRows,
  type PickerDevice,
  type PickerSection,
} from "./mention-picker.ts";

const row = (section: PickerSection, label: string, detail = "") => ({
  section,
  label,
  detail,
  payload: label,
});

const all = [
  row("Files", "research.md", "docs/research.md"),
  row("Devices", "omarchy", "This machine · Linux · online"),
  row("Spade bots", "Research", "Finds sources"),
  row("Agents", "Fix login", "Codex · working"),
  row("Clubs", "Launch", "Research and Writer"),
  row("Apps", "Linear", "App"),
];

it("the list shows its sections in one order: agents, bots, clubs, devices, apps, files", () => {
  expect(pickerRows(all, "").map((each) => each.section)).toEqual([
    "Agents",
    "Spade bots",
    "Clubs",
    "Devices",
    "Apps",
    "Files",
  ]);
});

it("typing filters across every section, and a near miss still finds its row", () => {
  expect(pickerRows(all, "res").map((each) => each.label)).toEqual([
    "Research",
    "Launch",
    "research.md",
  ]);
  expect(pickerRows(all, "omrch").map((each) => each.label)).toEqual(["omarchy"]);
  expect(pickerRows(all, "zzz")).toEqual([]);
});

it("the best match is highlighted first, wherever its section sits", () => {
  const rows = pickerRows(all, "lin");
  // "Linear" starts with what was typed; "Linux" in omarchy's line only contains it.
  expect(rows[bestRow(rows)]?.label).toBe("Linear");
});

const studio = { id: "host-studio", name: "Studio", here: false };
it("a device row says where it is and whether it answers, in words", () => {
  const machine: PickerDevice = {
    id: "primary",
    name: "omarchy",
    kind: "server",
    machine: { id: "primary", name: "omarchy", here: true },
    os: "Linux",
    online: true,
  };
  expect(deviceDetail(machine)).toBe("This machine · Linux · online");
  expect(
    deviceDetail({
      id: "SIM",
      name: "iPhone 17",
      kind: "simulator",
      machine: studio,
      model: "iPhone 17",
      online: true,
    }),
  ).toBe("iPhone 17 simulator · on Studio");
  expect(
    deviceDetail({ id: "p", name: "Pixel", kind: "phone", machine: studio, online: false }),
  ).toBe("Phone · paired with Studio · offline");
  expect(
    deviceDetail({
      id: "host-studio",
      name: "Studio",
      kind: "desktop",
      machine: studio,
      online: false,
    }),
  ).toBe("Studio · offline");
});

it("agents and clubs read as who they are and what they're doing", () => {
  expect(agentDetail({ threadId: "t", title: "Fix", provider: "codex", state: "waiting" })).toBe(
    "Codex · waiting for you",
  );
  expect(clubDetail({ id: "c", name: "Launch", members: ["A", "B", "C", "D"] })).toBe(
    "A, B and 2 more",
  );
});
