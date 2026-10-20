import type { AudioSink } from "./audio-fanout.ts";
import type { BrowserAudioChunk } from "./stream-audio.ts";
import type { BrowserVideoChunk } from "./stream-video.ts";
import type { VideoSink } from "./video-fanout.ts";
export type { CaptureViewer } from "./capture-policy.ts";

/**
 * Where one viewer's live view goes (ADR 0088, amended): encoded video only. A viewer without
 * a video sink (no binary transport) still follows the thread's state, but gets no pictures.
 */
export interface ViewerSink {
  video?: VideoSink<BrowserVideoChunk>;
  /** Takes the page's sound while the viewer plays video unmuted. */
  audio?: AudioSink<BrowserAudioChunk>;
}
