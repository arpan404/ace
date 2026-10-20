import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import type { PreviewSource, ScreenFrame } from "../sources.ts";
import { SpeakerButton } from "./speaker-button.tsx";

/** A source holding the person's speaker choice per thread, as the daemon preview does. */
function soundSource(playable: boolean) {
  const on = new Set<string>();
  const listeners = new Set<() => void>();
  const source = new Proxy({} as PreviewSource, {
    get(_, key) {
      if (key === "subscribe")
        return (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        };
      if (key === "audio") return (thread: string) => (playable ? on.has(thread) : undefined);
      if (key === "setAudio")
        return (thread: string, value: boolean) => {
          if (value) on.add(thread);
          else on.delete(thread);
          for (const listener of listeners) listener();
        };
      return () => undefined;
    },
  });
  return { source, on };
}

const video: ScreenFrame = {
  sequence: 1,
  src: "",
  width: 390,
  height: 800,
  video: { codedWidth: 1170, codedHeight: 2400, draw: () => true },
};
const jpeg: ScreenFrame = { sequence: 1, src: "blob:frame", width: 390, height: 800 };

test("a video view's sound starts muted, and one tap turns it on and off again", () => {
  const { source, on } = soundSource(true);
  render(<SpeakerButton source={source} threadId="thread-1" frame={video} />);
  fireEvent.click(screen.getByRole("button", { name: "Unmute the page" }));
  expect(on.has("thread-1")).toBe(true);
  const mute = screen.getByRole("button", { name: "Mute the page" });
  expect(mute.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(mute);
  expect(on.has("thread-1")).toBe(false);
  expect(screen.getByRole("button", { name: "Unmute the page" })).toBeTruthy();
});

test("no speaker where sound can't come: a JPEG view, or a client that can't play it", () => {
  const { source } = soundSource(true);
  const { unmount } = render(<SpeakerButton source={source} threadId="thread-1" frame={jpeg} />);
  expect(screen.queryByRole("button", { name: /mute the page/i })).toBeNull();
  unmount();
  render(<SpeakerButton source={soundSource(false).source} threadId="thread-1" frame={video} />);
  expect(screen.queryByRole("button", { name: /mute the page/i })).toBeNull();
});
