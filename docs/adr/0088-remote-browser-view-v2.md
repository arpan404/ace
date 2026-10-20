# 0088: Remote browser view v2: video over the ace socket

Date: 2026-10-19. Status: accepted. Amends [ADR 0083](0083-browser-v2-daemon-chrome.md)
(the screencast is no longer the only render path for remote clients) and
[ADR 0055](0055-browser-backends.md). Umbrella issue #1062; this ADR lands with #1053 (daemon)
and #1054 (client).

## Context

Web, phone and remote desktop clients watch a thread's browser as a stream of JPEG screenshots
from CDP `Page.startScreencast`. #1078 moved those JPEGs from base64 JSON to binary stream
messages, and the capture policy already sizes frames per viewer (pane CSS size × device pixel
ratio). JPEG still has three problems: every frame is a whole picture, so scrolling costs
hundreds of kilobytes per frame; quality has to drop under load, which smears text; and the frame
rate follows the round trip of one frame in flight.

The desktop app on the daemon's own machine shows the real page natively (an Electron
`WebContentsView`, ADR 0085) and is not affected by this decision.

## Decision

### One shared Chromium session

The agent and the person keep sharing one real Chromium session on the daemon machine: the same
tabs, sign-ins and cookies (ADR 0083). There is no second "viewer" browser and no per-client
browser. Whatever a client shows is a picture of the tab the agent works in, and the client's
input goes to that tab.

### Pixels, not a mirrored DOM

Clients get pixels of the page, not a copy of its DOM.

- A DOM mirror replays the page's markup and styles in the client's own engine. Pages depend on
  their origin, cookies, service workers, fonts, canvas, WebGL, video, iframes from other
  origins and timing. A mirror differs from what the agent sees in all of these, and the point of
  the view is to show exactly what the agent sees.
- A mirror would send page content (including private tabs and secret fields) to the client as
  text and markup, with all the injection problems of rendering third-party markup inside ace.
- Pixels work the same for every client (web, iOS, a remote desktop) and every page.

What pixels can't carry (cursor shape, pickers, tooltips, focused fields) travels next to them as
page state (#1059, #1074), and the client draws native UI for it.

### Video over the existing encrypted socket, not WebRTC

Encoded video travels as binary stream messages (`@ace/browser/stream`, #1078) on the socket the
client already has: the local socket, or the end-to-end encrypted relay. ace does not use WebRTC
for this.

- WebRTC needs ICE and, behind most NATs, a TURN server. ace is never hosted (ADR 0002), so ace
  would have to run or rent one, or the view would fail on exactly the networks the relay works
  on.
- The socket is already authenticated and encrypted end to end; a second channel would need its
  own pairing and keys.
- The cost is latency: TCP retransmits instead of dropping packets. The fanout drops whole frames
  instead (below), which keeps a slow link current rather than smooth. WebRTC can be added later
  as an optional transport if latency needs it.

### Where the encoder runs

The encoder runs inside the daemon's own Chrome for Testing, as a small extension that ace loads
into it (`packages/browser/video-extension`):

- The extension's service worker calls `chrome.tabCapture.getMediaStreamId` for the shown tab.
  ace finds the tab by its window: every ace tab has a window of its own, and CDP
  `Browser.getWindowForTarget` and `chrome.windows` use the same window ids.
- An offscreen document (`chrome.offscreen`, reason `USER_MEDIA`) opens the capture with
  `getUserMedia({ chromeMediaSource: "tab" })`, reads frames through
  `MediaStreamTrackProcessor` and encodes them with WebCodecs `VideoEncoder`.
- Encoded chunks reach the daemon through a CDP `Runtime.addBinding` on the offscreen document;
  the daemon drives the encoder with `Runtime.evaluate` on the same target. Everything goes over
  the existing CDP pipe: no port, no native host, no ffmpeg, and no second lossy step.
- The extension's id is fixed by the public key in its manifest, and Chrome starts with
  `--allowlisted-extension-id=<id>`. Tab capture normally needs a user gesture on the extension;
  the allowlist is what lets the daemon start it. The extension is loaded with
  `Extensions.loadUnpacked`, which ADR 0083's `--enable-unsafe-extension-debugging` allows.

The spike (Chrome for Testing 153, Apple M-series, `--headless=new`, a 1280 × 800 tab of text
scrolling continuously, 8 s runs) showed:

| Path                                      | Bit rate   | Frames/s | Chrome CPU (all processes) |
| ----------------------------------------- | ---------- | -------- | -------------------------- |
| H.264 hardware (`avc1.42E033`)            | 2.1 Mbit/s | 30       | 18–26 %                    |
| H.264 software                            | 2.1 Mbit/s | 30       | 36 %                       |
| VP8 software                              | 2.2 Mbit/s | 30       | 30 %                       |
| JPEG screencast, quality 80, no ack limit | 95 Mbit/s  | 60       | 45 %                       |

`VideoEncoder` scales frames itself when an encoder's size differs from the capture's, so one
capture feeds encoders of several sizes. Branded Chrome 155 accepted a hardware H.264 config and
then never produced a chunk, without an error. The encoder therefore has a watchdog: an encoder
that has had frames for a second without output is replaced by the next configuration
(hardware, then software, then the next codec).

Rejected:

- **ffmpeg on the daemon fed by the JPEG screencast.** A second lossy step, a large binary to
  ship and spawn, and the JPEG encode cost stays.
- **The CDP screencast feeding a `VideoEncoder` in an offscreen page.** Possible, but keeps the
  JPEG encode and decode for every frame. It remains the way to add video for a backend that
  has no tab capture.
- **`getDisplayMedia` with auto-select flags.** Needs a page of ace's inside the person's tab
  list and the flags select by title, which a page controls.

Limits of this choice:

- Tabs in a thread's private throwaway context (`profile: "ephemeral"`) are in another browser
  context the extension can't see; they stay on JPEG.
- The desktop's embedded backend (Electron views) has no extension; its remote viewers stay on
  JPEG until Electron's capture APIs feed the same encoder path.
- "Use my Chrome" (ADR 0084) is the person's own browser and keeps JPEG.

### Stream kinds

`@ace/browser/stream` kinds:

| Kind             | Carries                                                   | Who gets it                                                      |
| ---------------- | --------------------------------------------------------- | ---------------------------------------------------------------- |
| 1 `browserFrame` | one JPEG screencast frame                                 | viewers without video, and every viewer until its first keyframe |
| 2 `browserVideo` | one encoded video chunk (H.264 in AVC format, VP8 or VP9) | viewers that asked for video and got a keyframe                  |
| 3 `browserAudio` | one Opus packet of the tab's sound (below, Audio)         | video viewers that unmuted the page                              |

A video chunk's header carries the sequence, timestamp, the page's CSS size (input coordinates
stay CSS pixels, as with JPEG), the coded size, the codec string, a keyframe flag, the thread and
tab ids, and on keyframes the decoder description (the `avcC` record for H.264). The client
configures its decoder from a keyframe alone.

### Fallback rules

A client asks for video in `browser.subscribe` by listing the codecs its `VideoDecoder` supports.
The daemon then picks the first codec in that list its encoder supports.

- A client without WebCodecs, or with none of the codecs, doesn't ask and gets binary JPEG (or
  JSON JPEG on a transport without binary messages).
- A viewer that asked for video gets JPEG until its first keyframe is sent, and again whenever its
  encode stops (the tab changes, the encoder fails, a backend without video). There is no blank
  gap while video starts.
- The JPEG screencast keeps running for the session whatever viewers take. It feeds recordings,
  and recordings keep their privacy epochs (`live.ts`): a frame is recorded only when its capture
  time is after the tab's last private transition. Video never feeds a recording.
- Agent screenshots and model screenshots stay `Page.captureScreenshot`, unchanged.
- A viewer whose pane shows the native page (`nativeShown`) takes no video.

### Sizing and sharing encodes

Each viewer reports its pane (`browser.capture`). Its encode size is the page's CSS size times
the scale the pane shows it at, times the viewer's device pixel ratio. That is capped by the
pixels the tab renders and by 2560 px on the long side, and rounded to even numbers. Viewers of
the same tab share one encoder when their codec and load tier match and the shared size is at
most 25 % larger than each viewer's own; larger differences get their own encoder, up to four
per tab (more viewers join the nearest one). One tab capture feeds every encoder of the tab.

### Frame rate, bit rate and load

Each viewer has a load tier from how long it has been backed up, as the JPEG capture's pressure
does (`capture-policy.ts`). A viewer that falls behind moves to a lower tier, which is a separate
encode, so a slow viewer never slows the others:

| Tier               | Frames/s | Bits per pixel per frame |
| ------------------ | -------- | ------------------------ |
| 0, keeping up      | 30       | 0.07                     |
| 1, backed up 0.5 s | 15       | 0.09                     |
| 2, backed up 3 s   | 8        | 0.09                     |

Resolution stays; frame rate drops first. The bit rate is a variable-rate ceiling between
0.3 and 8 Mbit/s; a still page sends almost nothing.

### Keyframes and backpressure

- Keyframes are encoded when an encode starts (a viewer joins, a resize, a new tier), when a
  viewer asks after a decode error (`browser.ack` with `keyframe`), when the fanout dropped a
  delta for a viewer, and at least every 6 s. Forced keyframes for one encode are at least
  0.5 s apart.
- A still page produces no frames, so the encoder keeps the last captured frame and encodes it
  again when it owes a keyframe.
- JPEG keeps "one frame in flight". Video can't: a delta needs every delta before it, and one
  round trip per frame would cap a relay viewer at a few frames per second. A video viewer has a
  window of unacknowledged chunks instead: at most 8 chunks and 2 MiB (a lone keyframe may exceed
  the bytes). Acks are cumulative.
- When a delta doesn't fit the window, it is dropped, every later delta is dropped until the next
  keyframe, and a keyframe is requested. Keyframes are never dropped: a keyframe that doesn't fit
  waits in the viewer's queue, replacing an older queued one, and the deltas that follow it queue
  behind it (up to the window size).
- A hidden client keeps decoding but owes its acks until it is visible again, as with JPEG; the
  window fills, deltas drop, and the queued keyframe gives it a current picture as soon as it
  acks.

## Consequences

- A scrolling remote view costs a small fraction of the JPEG bytes, and text is not smeared
  under load. `packages/browser/bench/video-wire.ts` (in `check:perf`) holds video under 40 % of
  JPEG's bytes for a 60 s scroll of a 1280 × 800 pane at DPR 2, two remote viewers acking 30 ms
  after each frame. Measured on an Apple M-series machine under heavy unrelated load:

  | Chrome                                         | Video                | JPEG                | Ratio |
  | ---------------------------------------------- | -------------------- | ------------------- | ----- |
  | Chrome for Testing 153 (hardware H.264)        | 3.3 Mbit/s, 18.4 fps | 39 Mbit/s, 9.4 fps  | 0.08  |
  | Chrome 155 (software H.264 after the watchdog) | 7.4 Mbit/s, 26.6 fps | 49 Mbit/s, 11.9 fps | 0.15  |

- The daemon's Chrome runs one more extension, with an offscreen document while anyone watches
  video. It is ace's own and holds no data.
- Phone and web clients need a canvas path next to the `<img>` path; input coordinates still map
  through the picture's rendered box, in CSS pixels.
- Open: the desktop's embedded backend and ephemeral contexts stay on JPEG, and so without sound.

## Audio

Added with #1055. The page's sound rides the video's tab capture and the same stream framing.

### Muted by default, everywhere

Every view starts muted, on every device, and a view that stops showing the page goes back to
muted. One speaker button in the browser tab's toolbar turns the sound on for that device only.
The click is what opens the client's audio output (`AudioContext`), because phone browsers only
start sound inside a user gesture. The button is offered while the page shows as video on a
client with WebCodecs `AudioDecoder` and Web Audio; a JPEG view has no sound.

The viewer's choice travels in its pane report: `BrowserCaptureViewport.audio` in
`browser.subscribe` and `browser.capture`. It is not a tab property and not the person's tab
mute (`browser.tabs.mute`, ADR 0086), which changes what a tab plays for everyone.

### Bandwidth: sound only while someone listens

A viewer listens while it plays video, its `audio` is true and no native view covers its pane
(`audio-fanout.ts`, pure). The tab capture always holds the tab's audio track, but the offscreen
document reads and encodes a clone of it only while at least one viewer listens, and the daemon
sends audio chunks only to listeners. A muted viewer receives no audio bytes, and a capture that
nobody hears costs no encoding.

Audio is never acknowledged and never queued: a chunk the transport refuses is dropped, since
late sound is worse than a gap. It is 96 kbit/s Opus at most, with DTX, so a silent page sends
almost nothing.

### Capture and encoding

- The offscreen document opens the capture with `audio` and `video` from the same stream id.
  A capture that can't take sound opens with video alone.
- `AudioEncoder` encodes Opus (`opus`, the track's own rate and channels, 20 ms packets, DTX).
- Each chunk, video and audio, says how long ago (`age`) its picture or sound was captured. The
  daemon stamps it `now − age`, so both kinds carry capture time on one clock. Video frames are
  stamped with the offscreen document's `performance.now()` as they go in; audio samples carry
  the capture's own media timestamps, mapped onto that clock by their quickest arrival
  (`media-clock.ts`, pure, re-anchored when either clock jumps).
- An audio chunk's header carries the sequence, timestamp, sample rate, channels, codec, and the
  thread and tab ids (`stream-audio.ts`).

### Playing in step with the video

Pictures show as soon as they decode; sound needs a jitter buffer. The client keeps two offsets,
local time minus stream time: the video's (smoothed over shown pictures) and the sound's
(its quickest recent arrival plus a 60 ms buffer). Each chunk plays at its timestamp plus the
later of the two, so sound waits for pictures that run late, but at most 500 ms beyond its own
buffer (`av-sync.ts`, pure). The schedule holds while the target moves less than 60 ms, so
packets play back to back; a larger move, or a packet that would start in the past, restarts it
with one short gap. The video's offset is tracked while muted, so unmuting starts in step. Web
Audio's `getOutputTimestamp` maps local time to the output device, through its latency.

### The daemon machine stays silent

ace's Chrome used to run with `--mute-audio`. That flag mutes the page's output streams before
tab capture taps them: a capture of a page playing a 440 Hz tone under `--mute-audio` decoded to
silence (peak 2 × 10⁻³⁴), and without it to the tone. Removing it alone would play every agent's
page on the daemon machine's speakers (macOS showed `coreaudiod` holding the built-in speaker for
headless Chrome).

ace's Chrome runs with `--disable-audio-output` instead: Chrome's audio output goes to a fake
device, while tab capture still receives the streams. With it, the same tone reached the capture
intact and no new speaker assertion appeared. So agent sessions, sessions nobody watches and
muted viewers are all silent on the daemon machine, and no flag changes between sessions with
and without a viewer.

### Limits

- Sound comes only with video: JPEG viewers, ephemeral contexts, the desktop's embedded backend
  (which plays through the desktop itself) and "Use my Chrome" have none.
- Clients without WebCodecs `AudioDecoder` for Opus (older Safari) get no speaker button.
- The jitter buffer is fixed at 60 ms over the quickest arrival; a link with larger jitter
  restarts the schedule more often rather than buffering more.
