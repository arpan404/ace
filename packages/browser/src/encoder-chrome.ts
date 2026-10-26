import type { BrowserCdp, CaptureEvents, VideoCaptureHandle, VideoHost } from "./backend.ts";
import { ChromeHost, type ChromeHostOptions } from "./chrome-host.ts";
import type { ChromeInstance } from "./chrome-instance.ts";
import { ChromeVideo } from "./chrome-video.ts";

/*
 * A Chrome of ace's that only encodes video (ADR 0088, amended): for a backend with no Chrome of
 * ace's behind its pages ("Use my Chrome", ADR 0084). Its captures are fed the page's own
 * screencast pictures (`ChromeVideo.openPictures`), so it opens no tab of its own. Chrome starts
 * with the first capture or codec probe and stops `launch.idleMs` after the last one ends.
 */
export class EncoderChrome {
  private host: ChromeHost;
  private profileDir: string;
  private videos = new WeakMap<ChromeInstance, ChromeVideo>();
  private lifetime = new AbortController();
  private delay: (milliseconds: number) => Promise<void>;
  private platform: NodeJS.Platform;
  constructor(options: ChromeHostOptions) {
    this.platform = options.platform;
    this.host = new ChromeHost(options);
    this.profileDir = options.profileDir;
    const schedule = options.cleanup.schedule;
    this.delay = (milliseconds) =>
      new Promise((resolve) => void schedule(() => resolve(), milliseconds));
  }
  /** The encoder as a video host; nothing starts until a viewer's capture asks. */
  readonly video: VideoHost = {
    supported: async (codecs, width, height) => {
      const lease = await this.host.acquire(this.lifetime.signal);
      try {
        return await this.encoder(lease.instance).supported(codecs, width, height);
      } finally {
        lease.release();
      }
    },
    open: (page, width, height, events) => this.capture(page, width, height, events),
    encodePictures: (width, height, events) => this.capture(undefined, width, height, events),
  };
  /** One encode fed pictures: a Chrome lease held while it runs. */
  private async capture(
    page: BrowserCdp | undefined,
    width: number,
    height: number,
    events: CaptureEvents,
  ): Promise<VideoCaptureHandle> {
    {
      const lease = await this.host.acquire(this.lifetime.signal);
      let held = true;
      const release = (): boolean => {
        if (!held) return false;
        held = false;
        lease.release();
        return true;
      };
      let handle: VideoCaptureHandle;
      try {
        handle = await this.encoder(lease.instance).openPictures(page, width, height, {
          chunk: (chunk) => events.chunk(chunk),
          failed: (encode) => events.failed(encode),
          ended: () => {
            if (release()) events.ended();
          },
        });
      } catch (error) {
        release();
        throw error;
      }
      // A crashed or killed encoder ends its captures; the next capture starts another.
      void lease.instance.exited.then(() => {
        if (release()) events.ended();
      });
      return {
        encodes: (specs) => handle.encodes(specs),
        keyframe: (encode) => handle.keyframe(encode),
        ...(handle.pictures ? { pictures: handle.pictures } : {}),
        close: () => {
          if (!release()) return;
          handle.close();
        },
      };
    }
  }
  /** Stops the encoder now; later captures fail. */
  async close(): Promise<void> {
    this.lifetime.abort();
    await this.host.close();
  }
  private encoder(instance: ChromeInstance): ChromeVideo {
    let video = this.videos.get(instance);
    if (!video) {
      video = new ChromeVideo({
        connection: instance.connection,
        targets: instance.targets,
        directory: `${this.profileDir}-video-extension`,
        delay: this.delay,
        platform: this.platform,
      });
      this.videos.set(instance, video);
    }
    return video;
  }
}
