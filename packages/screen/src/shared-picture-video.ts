import type { ScreenStreamSettings } from "@ace/protocol";
import { PicturesToVideo, type PicturesToVideoOptions } from "./picture-video.ts";
import type { Frame } from "./frames.ts";

/** Session-owned encodes. A lease moves between groups as its link settings change. */
export class SharedPictureVideos {
  readonly #groups = new Map<
    string,
    {
      video: PicturesToVideo;
      settings: ScreenStreamSettings;
      viewers: Set<(frame: Frame) => void>;
      push(frame: Frame): void;
    }
  >();
  #generation = 0;
  open(options: PicturesToVideoOptions) {
    let key: string | undefined;
    let latest: Frame | undefined;
    let closed = false;
    const stop = () => {
      const group = key === undefined ? undefined : this.#groups.get(key);
      group?.viewers.delete(options.frame);
      if (group && !group.viewers.size) {
        group.video.close();
        this.#groups.delete(key ?? "");
      }
      key = undefined;
    };
    return {
      want: (settings: ScreenStreamSettings): boolean => {
        if (closed || !options.host()?.encodePictures) return false;
        const next = JSON.stringify([
          options.sessionId,
          settings.codec,
          settings.maxWidth,
          settings.maxHeight,
          settings.fps,
          settings.bitrate,
        ]);
        if (next === key) return true;
        const current = key === undefined ? undefined : this.#groups.get(key);
        if (
          current &&
          current.viewers.size === 1 &&
          !this.#groups.has(next) &&
          current.settings.codec === settings.codec &&
          current.settings.maxWidth === settings.maxWidth &&
          current.settings.maxHeight === settings.maxHeight &&
          current.settings.fps === settings.fps
        ) {
          this.#groups.delete(key ?? "");
          key = next;
          current.settings = settings;
          this.#groups.set(next, current);
          current.video.want(settings);
          return true;
        }
        stop();
        key = next;
        let group = this.#groups.get(next);
        const joining = group !== undefined;
        if (!group) {
          const viewers = new Set<(frame: Frame) => void>();
          const generation = ++this.#generation;
          const video = new PicturesToVideo({
            ...options,
            frame: (frame) => {
              const shared = {
                ...frame,
                header: { ...frame.header, captureGeneration: generation },
              };
              for (const viewer of viewers) viewer(shared);
            },
          });
          let previous: Frame | undefined;
          group = {
            video,
            settings,
            viewers,
            push(frame) {
              if (frame === previous) return;
              previous = frame;
              video.push(frame);
            },
          };
          this.#groups.set(next, group);
          video.want(settings);
        }
        group.viewers.add(options.frame);
        group.video.keyframe();
        if (latest) {
          // A late viewer of a still window needs a fresh keyframe even without a repaint.
          if (joining) group.video.push(latest);
          else group.push(latest);
        }
        return true;
      },
      push: (frame: Frame) => {
        if (closed) return;
        latest = frame;
        if (key !== undefined) this.#groups.get(key)?.push(frame);
      },
      keyframe: () => key !== undefined && (this.#groups.get(key)?.video.keyframe() ?? false),
      stop,
      close: () => {
        closed = true;
        latest = undefined;
        stop();
      },
    };
  }
}
