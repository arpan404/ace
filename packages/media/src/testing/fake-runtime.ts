import { encodeEgress, type MediaFrame } from "../frame.ts";
import type { IngestProducer, IngestSource } from "../ingest-sources.ts";
import { encodeProducerStamp } from "../producer-stamp.ts";
import { sourceKinds } from "../routes.ts";
import { MediaRuntime } from "../runtime.ts";
import { harness } from "../supervisor-test-support.ts";

/**
 * The daemon's real `MediaRuntime` (supervisor, routes, sources, egress router) with the
 * ace-media process faked at its lanes and the clock and restart jitter injected. For producer
 * adapters' tests: ace-media answers every `source.open` with `starting`, and `keyframe(source)`
 * sends one decodable H.264 unit back on egress for a source it holds, as ace-media does once a
 * producer streams to it.
 */
export function fakeMediaRuntime(random = 0.5) {
  let draws = 0;
  const h = harness({
    random: () => random,
    // Every token new, as the platform's would be.
    randomBytes: (length) => {
      draws++;
      return Uint8Array.from({ length }, (_, i) => (i * 7 + draws * 13) & 0xff);
    },
  });
  const {
    replay: _replay,
    onMessage: _message,
    onEgress: _egress,
    onExit: _exit,
    ...options
  } = h.options;
  let ids = 0;
  const runtime = new MediaRuntime({
    ...options,
    id: () => `m${++ids}`,
    capabilities: { ingest: sourceKinds, delivery: false },
  });
  const answered = new Set<string>();
  /** The live source id ace-media gave each producer, by the daemon's name, and its handle. */
  const opened = new Map<string, { id: string; handle: number }>();
  const answer = () => {
    const child = h.host.children.at(-1);
    if (!child || child.gone) return;
    for (const { message } of child.stdin.messages("normal"))
      if (message.type === "source.open" && !answered.has(message.source)) {
        answered.add(message.source);
        opened.set(message.source, { id: message.source, handle: message.handle });
        child.send({ type: "source.status", source: message.source, status: "starting" });
      }
  };
  let sequence = 0;
  return {
    runtime,
    clock: h.clock,
    host: h.host,
    /** The sources a producer adapter added, recorded so a test can reach them. */
    media: {
      add: (producer: IngestProducer): IngestSource => runtime.sources.add(producer),
    },
    /** Moves the clock in 10 ms steps, answering opens, until `done` or `ms`. */
    async run(ms: number, done: () => boolean, each?: () => void): Promise<void> {
      for (let waited = 0; waited <= ms && !done(); waited += 10) {
        answer();
        each?.();
        await h.clock.advance(10);
      }
    },
    /** ace-media's id and egress handle for the newest open of every source. */
    opens: () => [...opened.values()],
    /** One H.264 keyframe back on egress for handle `handle`, stamped as a screen's would be. */
    keyframe(handle: number, encode = 0): void {
      const child = h.host.children.at(-1);
      if (!child || child.gone) return;
      const unit: MediaFrame = {
        kind: 1,
        flags: 1 | 4,
        ageUs: 0,
        width: 640,
        height: 400,
        displayWidth: 640,
        displayHeight: 400,
        scale: 1000,
        rotation: 0,
        codec: 1,
        encode,
        epoch: 0,
        codecString: "avc1.640033",
        description: new Uint8Array([1, 0x64, 0, 0x33]),
        extension: encodeProducerStamp({ sequence: ++sequence, timestamp: sequence, scale: 1 }),
        payload: new Uint8Array([0, 0, 0, 1, 0x65, 0x88, sequence & 0xff]),
      };
      child.lane("egress").source.emit(encodeEgress(handle, 0, unit));
    },
    kill(): void {
      h.host.last.kill();
    },
    dispose(): void {
      runtime.dispose();
    },
  };
}
