import { describe, expect, it } from "vitest";
import { ViewerSizes } from "./viewer-sizes.ts";

const desk = { width: 1200, height: 800, touch: false };
const phone = { width: 390, height: 700, touch: true, devicePixelRatio: 3 };
const before = { width: 1280, height: 720 };

describe("the most recent viewer's size wins, and the previous one returns when it leaves", () => {
  it("a phone that stops watching gives the page back to the desktop viewer's size", () => {
    const sizes = new ViewerSizes();
    sizes.record("desktop", desk, before);
    sizes.record("phone", phone, desk);
    expect(sizes.release("phone")).toEqual(desk);
  });

  it("the desktop leaving while the phone still shows its size changes nothing", () => {
    const sizes = new ViewerSizes();
    sizes.record("desktop", desk, before);
    sizes.record("phone", phone, desk);
    expect(sizes.release("desktop")).toBeUndefined();
    // The phone is the only viewer left; when it goes, the desktop's last size comes back.
    expect(sizes.release("phone")).toEqual(desk);
  });

  it("a desktop that sizes the page again takes it back from the phone", () => {
    const sizes = new ViewerSizes();
    sizes.record("desktop", desk, before);
    sizes.record("phone", phone, desk);
    sizes.record("desktop", { ...desk, width: 1000 }, phone);
    expect(sizes.release("phone")).toBeUndefined();
    expect(sizes.release("desktop")).toBeUndefined();
  });

  it("a lone phone that leaves puts the page back at the size it had before", () => {
    const sizes = new ViewerSizes();
    sizes.record("phone", phone, before);
    sizes.record("phone", { ...phone, width: 700, height: 390 }, phone);
    expect(sizes.release("phone")).toEqual({ ...before, touch: false });
  });

  it("a lone desktop viewer that leaves keeps the page at its size", () => {
    const sizes = new ViewerSizes();
    sizes.record("desktop", desk, before);
    expect(sizes.release("desktop")).toBeUndefined();
  });

  it("a connection that never sized the page changes nothing when it leaves", () => {
    const sizes = new ViewerSizes();
    sizes.record("phone", phone, before);
    expect(sizes.release("someone")).toBeUndefined();
    expect(sizes.release("phone")).toEqual({ ...before, touch: false });
  });
});
