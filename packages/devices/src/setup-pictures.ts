import type { CapturedPicture, PictureView } from "@ace/browser/picture-channel";

/** What a subscribe holds while it is set up: a keyframe and the deltas after it, at most this. */
const heldBytesLimit = 8 * 1024 * 1024;

/**
 * The pictures a device subscribe's capture sends while that subscribe is still being set up.
 * The view opens only once setup is done (opening it replaces the committed one's), but the
 * capture's first H.264 keyframe, the screen as it is, comes during setup, when the view's
 * request starts the video. A still screen makes no other picture, so dropping it would leave
 * the viewer blank. They are held from the latest keyframe and go to the view when it opens.
 */
export class SetupPictures {
  #held: CapturedPicture[] = [];
  #bytes = 0;
  /** A delta came with no keyframe held before it, or the held ones outgrew the limit. */
  #owesKeyframe = false;
  #view: PictureView | undefined;

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
  open(view: PictureView, keyframe: () => void): void {
    const held = this.#held;
    this.#held = [];
    this.#bytes = 0;
    this.#view = view;
    for (const picture of held) view.push(picture);
    if (this.#owesKeyframe && held.length === 0) keyframe();
  }
}
