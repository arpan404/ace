import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DegradedLine, degradedSentence, VideoStatusLine } from "./degraded.tsx";

const steps = [{ step: "encode", backend: "cpu", hardware: false, readbacks: 1, uploads: 0 }];
const sentence = "Video runs on the processor here: this computer has no hardware video encoder.";

describe("the degraded sentence", () => {
  it("is ace-media's reason while the source is degraded", () => {
    expect(degradedSentence({ steps, degraded: true, reason: sentence })).toBe(sentence);
  });

  it("is a plain default when a degraded source gives no reason", () => {
    expect(degradedSentence({ steps, degraded: true })).toBe("Video runs on the processor here.");
    expect(degradedSentence({ steps, degraded: true, reason: "  " })).toBe(
      "Video runs on the processor here.",
    );
  });

  it("ends as a sentence even when the reason doesn't", () => {
    expect(degradedSentence({ steps, degraded: true, reason: "No hardware encoder" })).toBe(
      "No hardware encoder.",
    );
  });

  it("is absent while the source isn't degraded, even with a reason", () => {
    expect(degradedSentence({ steps, degraded: false, reason: sentence })).toBeUndefined();
    expect(degradedSentence(undefined)).toBeUndefined();
  });

  it("shows as one line of words exactly while degraded", () => {
    const { rerender } = render(
      <DegradedLine acceleration={{ steps, degraded: true, reason: sentence }} />,
    );
    const line = screen.getByRole("status");
    expect(line.textContent).toBe(sentence);
    expect(line.children).toHaveLength(0);
    rerender(<DegradedLine acceleration={{ steps, degraded: false }} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("a live view whose video can't play", () => {
  it("says why in one line of words, in place of the degraded sentence, and nothing once it plays", () => {
    const acceleration = { steps, degraded: true, reason: sentence };
    const { rerender } = render(
      <VideoStatusLine
        video={{ status: "unavailable", reason: "ace-media isn't available on this computer" }}
        acceleration={acceleration}
      />,
    );
    const line = screen.getByRole("status");
    expect(line.textContent).toBe("ace-media isn't available on this computer.");
    expect(line.children).toHaveLength(0);
    // Playing again: back to what it runs on.
    rerender(<VideoStatusLine video={undefined} acceleration={acceleration} />);
    expect(screen.getByRole("status").textContent).toBe(sentence);
    rerender(<VideoStatusLine video={undefined} acceleration={undefined} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
