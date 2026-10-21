import { expect, test } from "vitest";
import { soundControl } from "./sound-mark.tsx";

test("a silent, unmuted page shows no speaker", () => {
  expect(soundControl({ audible: false, muted: false }, undefined)).toBeUndefined();
  expect(soundControl(undefined, false)).toBeUndefined();
});

test("a page heard here offers to mute its tab", () => {
  expect(soundControl({ audible: true }, undefined)).toEqual({
    muted: false,
    label: "Mute tab",
    step: { kind: "mute-tab" },
  });
  expect(soundControl({ audible: true }, true)?.step).toEqual({ kind: "mute-tab" });
});

test("a video view with its sound off here shows the page as muted and turns sound on here", () => {
  expect(soundControl({ audible: true }, false)).toEqual({
    muted: true,
    label: "Turn on sound",
    step: { kind: "play-here" },
  });
});

test("unmuting a muted tab also turns sound on in a video view that has it off", () => {
  expect(soundControl({ audible: true, muted: true }, false)?.step).toEqual({
    kind: "unmute-tab",
    hereToo: true,
  });
  expect(soundControl({ muted: true }, undefined)).toEqual({
    muted: true,
    label: "Unmute tab",
    step: { kind: "unmute-tab", hereToo: false },
  });
});
