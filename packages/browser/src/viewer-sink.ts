export type { CaptureViewer } from "./capture-policy.ts";

/**
 * Where one viewer's live view goes (ADR 0088, ADR 0147): nowhere on its own connection. ace-media
 * delivers its video and sound on the client's media connection (X3); the viewer follows the
 * thread's state here.
 */
export interface ViewerSink {
  /**
   * The viewer is on this machine (the daemon's loopback listener): its link carries whatever
   * the encoder makes, so its first encode starts at the top rate.
   */
  local?: boolean;
}
