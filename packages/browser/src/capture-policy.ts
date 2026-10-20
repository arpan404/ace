import type { BrowserCaptureViewport, BrowserVideoRequest } from "@ace/protocol";

/*
 * What a viewer shows, and how ace's Chrome screencasts a page for its own use (ADR 0088,
 * amended). Viewers get video only (`video-policy.ts`); the JPEG screencast feeds recordings
 * and keeps a headless page drawing while an agent works it, so it has one fixed setting sized
 * for the recording budget.
 */

export interface CaptureViewer {
  viewport: BrowserCaptureViewport;
  /** The codecs the viewer decodes (ADR 0088); without them it gets no pictures. */
  video?: BrowserVideoRequest;
}

export interface CaptureSettings {
  fps: number;
  everyNthFrame: number;
  quality: number;
  maxWidth: number;
  maxHeight: number;
}

/** The long side of the largest picture: a 1280-px pane at DPR 2, a phone at DPR 3. */
export const longestFrameSide = 2560;

/** The screencast recordings and agent work use: the recording budget, readable text. */
export const screencastSettings: CaptureSettings = {
  fps: 15,
  everyNthFrame: 1,
  quality: 80,
  maxWidth: 1280,
  maxHeight: 960,
};
