import type { CapturedPicture } from "./picture-viewer.ts";

/** What a subscribe holds while it is set up: a keyframe and the deltas after it, at most this. */
const heldBytesLimit = 8 * 1024 * 1024;

/** Where the held pictures go: the subscribe's view (`PictureChannel.open`). */
type PictureSink = { push(picture: CapturedPicture): void };

/**
 * The pictures a subscribe's capture sends while that subscribe is still being set up (a device's
 * or a computer-use session's). The view opens only once setup is done (opening it replaces the
 * committed one's), but what it should start from comes during setup: a device capture's first
 * H.264 keyframe, made when the view's request starts the video, or the screen's current picture,
 * handed over as the subscribe joins. A still screen makes no other picture, so dropping it would
 * leave the viewer blank. They are held from the latest keyframe and go to the view when it opens.
 */
export class SetupPictures {
  #held: CapturedPicture[] = [];
  #bytes = 0;
  /** A delta came with no keyframe held before it, or the held ones outgrew the limit. */
  #owesKeyframe = false;
  #view: PictureSink | undefined;

  push(picture: CapturedPicture): void {
    if (this.#view) return this.#view.push(picture);
    if (picture.key) {
      this.#held = [picture];
      this.#bytes = picture.bytes.byteLength;
      this.#owesKeyframe = false;
      return;
    }
    if (this.#held.length === 0 || this.#bytes + picture.bytes.byteLength > heldBytesLimit) {
      this.#held = [];
      this.#bytes = 0;
      this.#owesKeyframe = true;
      return;
    }
    this.#held.push(picture);
    this.#bytes += picture.bytes.byteLength;
  }

  /** Setup is done: what was held goes to `view`, then every later picture. */
  open(view: PictureSink, keyframe: () => void): void {
    const held = this.#held;
    this.#held = [];
    this.#bytes = 0;
    this.#view = view;
    for (const picture of held) view.push(picture);
    if (this.#owesKeyframe && held.length === 0) keyframe();
  }
}
