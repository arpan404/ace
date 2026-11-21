import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import type { BrowserView } from "../sources.ts";
import { RecordingNotice } from "./recording-indicator.tsx";

const browserView = (extra: Partial<BrowserView> = {}): BrowserView => ({
  threadId: "thread-recording",
  url: "https://example.com/",
  closed: false,
  ...extra,
});

const sentence = "The recording is saved, but ace-media couldn't confirm its last moment.";

test("a recording notice shows its own sentence", () => {
  render(<RecordingNotice view={browserView({ recordingNotice: sentence })} />);
  expect(screen.getByRole("status").textContent).toBe(sentence);
});

test("the sentence goes when a new recording starts or the notice is cleared", () => {
  const { rerender } = render(
    <RecordingNotice view={browserView({ recordingNotice: sentence })} />,
  );
  expect(screen.getByText(sentence)).toBeTruthy();
  rerender(<RecordingNotice view={browserView({ recording: { by: { kind: "human" } } })} />);
  expect(screen.queryByText(sentence)).toBeNull();
});
