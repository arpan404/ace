# 0088: Remote browser view v2: video over the ace socket

Date: 2026-10-19. Status: accepted. Amends [ADR 0083](0083-browser-v2-daemon-chrome.md)
(the screencast is no longer the only render path for remote clients) and
[ADR 0055](0055-browser-backends.md). Umbrella issue #1062; this ADR lands with #1053 (daemon)
and #1054 (client).

Amended 2026-10-20 (owner decision): live views are video only, at a steady 60 fps, with the bit
rate following each viewer's link. See "Amendment: video only, 60 fps" at the end. Where the
sections below describe JPEG viewers, frame-rate tiers or the 8-chunk window, the amendment
replaces them.

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
- The desktop's embedded backend (Electron views) has no extension; the desktop runs the same
  encoder itself (below, The desktop's encoder).
- "Use my Chrome" (ADR 0084) is the person's own browser; the extension can't capture it
  either (amended: see "Use my Chrome's encoder").

### Stream kinds

`@ace/browser/stream` kinds:

| Kind             | Carries                                                   | Who gets it                                                      |
| ---------------- | --------------------------------------------------------- | ---------------------------------------------------------------- |
| 1 `browserFrame` | one JPEG screencast frame                                 | viewers without video, and every viewer until its first keyframe |
| 2 `browserVideo` | one encoded video chunk (H.264 in AVC format, VP8 or VP9) | viewers that asked for video and got a keyframe                  |
| 3 `browserAudio` | one Opus packet of the tab's sound (below, Audio)         | video viewers that unmuted the page                              |
| 4 `deviceFrame`  | one picture of a simulator or emulator (ADR 0064)         | device live views, paced by `devices.ack`                        |
| 5 `screenFrame`  | one picture of a computer-use session (ADR 0011)          | computer-use live views, paced by `screen.ack`                   |

Kinds 4 and 5 share one header (`stream-picture.ts`) and one paced viewer
(`@ace/browser/picture-channel`), with this ADR's window, drop and keyframe rules. Since #1129
this envelope is the only binary format any live view receives: there is one media pipeline.

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
- Open: ephemeral contexts stay on JPEG, and so without sound. The desktop's embedded backend
  streams video without sound (The desktop's encoder).

## Audio

Added with #1055. The page's sound rides the video's tab capture and the same stream framing.

### Muted by default, everywhere

Every view starts muted, on every device, and a view that stops showing the page goes back to
muted. As in a browser, a speaker at the end of the address bar appears only while the page plays
sound or its tab is muted. While the page plays and this device has its sound off, the speaker
shows crossed out and a click turns the sound on for that device only; unmuting a muted tab from
it does the same. Once the person hears it, a click mutes the tab. The tab's right-click menu
has Mute tab and Unmute tab. The click is what opens the client's audio output
(`AudioContext`), because phone browsers only start sound inside a user gesture. Sound is offered
while the page shows as video on a client with WebCodecs `AudioDecoder` and Web Audio; a JPEG
view has no sound.

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

- Sound comes only with video: JPEG viewers, ephemeral contexts and "Use my Chrome" have none.
  The desktop's embedded backend sends video without sound: its views play through the desktop
  itself, and capturing their sound would take it off the desktop's speakers (below).
- Clients without WebCodecs `AudioDecoder` for Opus (older Safari) get no sound here.
- The jitter buffer is fixed at 60 ms over the quickest arrival; a link with larger jitter
  restarts the schedule more often rather than buffering more.

## Amendment: video only, 60 fps

Date: 2026-10-20. Status: accepted (owner decision).

### Why

Watched from a phone over 5G and Tailscale, the view ran at 5 fps on JPEG and between 5 and
38 fps on video, never steady. A phone-link benchmark (`packages/browser/bench/video-link.ts`:
real headless Chrome, a simulated link with bandwidth, delay and jitter) reproduced it:

| Link                          | Before                                 | After            |
| ----------------------------- | -------------------------------------- | ---------------- |
| 25 Mbit/s, 120 ms             | 30 fps (the cap)                       | 59–61 fps        |
| 25 Mbit/s, 200 ms, 100 jitter | 13–16 fps, 29 forced keyframes in 15 s | 56–64 fps        |
| 4 Mbit/s, 120 ms              | 1–8 fps                                | 45–68, median 60 |
| 10 Mbit/s, 150 ms, 60 jitter  | —                                      | 56–62 fps        |

The causes: a 30 fps cap; frame-rate tiers that dropped a viewer to 15 and 8 fps whenever it
was "backed up", which a long round trip always looks like; an 8-chunk window that a 60 fps
stream over a 150 ms round trip fills by itself; and the rule that a dropped delta drops
everything until a keyframe at least 500 ms away, so one overflow froze the picture and the
keyframe that followed overflowed again. The encoder's bit rate never followed the link.

### Decision

- **No JPEG to any viewer.** Live views carry encoded video only (`browserVideo`, and H.264
  pictures for devices and, since 2026-10-20, computer-use sessions: a watching view asks the
  Mac's screen helper for 60 fps H.264 with `stream.configure`, the bridge forwards only video,
  and a helper that can't encode it leaves the view saying so). There is no JPEG before the first keyframe, no JPEG when an encode
  stops, and no JPEG for clients without WebCodecs: those show that they can't decode video.
  `browserFrame` is no longer sent to viewers. The JPEG screencast is internal: it feeds
  recordings and keeps a headless page drawing while an agent works it, with one fixed setting.
- **60 fps always.** Every encode runs at 60 fps and the tab capture asks for 60. A link that
  can't carry the picture costs quality, never frames.
- **The bit rate follows each viewer's link** (`link-rate.ts`, pure). Every chunk's round trip
  (sent → cumulative ack) is smoothed, and compared with the lowest smoothed round trip of the
  last 10 s; comparing smoothed with smoothed cancels a link's steady jitter. Near that floor
  the rate climbs 8 % per 200 ms, up to 1.3 × the best rate the link delivered in the last
  30 s. More than 80 ms above it, the rate falls to 90 % of what was delivered in the last
  second, and holds for a round trip while that queue drains. A dropped chunk cuts it to 60 %.
  Bounds: 0.5–16 Mbit/s; a viewer starts at 4 Mbit/s. An encode shared by several viewers runs
  at the slowest member's rate. The encoder takes a new rate in place (`VideoEncoder.configure`
  with the same codec and size), so a rate change costs no keyframe; the encode key no longer
  carries the rate or a tier.
- **Thin links get a smaller picture, not fewer frames** (`video-scale.ts`, pure). Below about
  0.02 bits per pixel per frame a real-time encoder skips frames to hold its rate (0.5 Mbit/s at
  2560 × 1600 gave 20 fps). The picture steps down by 0.84 per side, at most six steps, once the
  link has stayed short for 1 s, and steps back up once it has carried the larger picture with
  30 % spare for 3 s. Each step is a new encode and a keyframe. The tab capture stays at the
  full size; the encoder scales.
- **A one-second window.** A viewer may have 60 chunks or 8 MiB unacknowledged. On a link that
  keeps up nothing is dropped; the rate control keeps the window from filling. The drop rule for
  a delta that still doesn't fit is unchanged.
- **Keyframes at least every 20 s** (was 6 s): a keyframe is many deltas big, and a viewer that
  lost its place asks for one at once.
- **Every backend streams video.** ace's Chrome uses tab capture. A tab in a private context,
  which the extension can't capture, is encoded from its own screencast (JPEG at quality 80, up
  to 1920 px on the long side, decoded and encoded by the same offscreen document): the wire
  still carries only video, at 58–61 fps in the benchmark. The desktop's embedded views get an
  encoder of their own ("The desktop's encoder", below). "Use my
  Chrome" tabs are encoded from their screencast too, by a Chrome of ace's that only encodes
  ("Use my Chrome's encoder", below).

### Thin links: ace's own rate control, HEVC first

Added the same day. Measured in Chrome for Testing on Apple silicon, a scrolling page at
1280 × 800 encoded for 3 s per setting:

| Encoder                        | 1 Mbit/s asked | Frames kept | Bits out                       |
| ------------------------------ | -------------- | ----------- | ------------------------------ |
| H.264 hardware, `variable`     | 1 Mbit/s       | 16 of 60    | 1.0 Mbit/s                     |
| H.264 software, `variable`     | 1 Mbit/s       | 60          | 15.7 Mbit/s (ignores the rate) |
| VP8 / VP9 software             | 1 Mbit/s       | 60          | 10.6 / 6.0 Mbit/s (ignore it)  |
| H.264 hardware, `quantizer` 48 | —              | 60          | 1.2 Mbit/s                     |
| HEVC hardware, `quantizer` 48  | —              | 60          | 0.4 Mbit/s                     |

A hardware encoder holds a bit rate by skipping frames, and the software ones don't hold it.

- **`quantizer` mode with ace's own rate control** (`quantizer-control.ts`, pure, bundled into
  the extension). Where the hardware takes it (H.264, HEVC), the encoder runs in `quantizer`
  mode and codes every frame at a quantizer ace picks. The quantizer moves by about
  3 × log2(recent delta size ÷ target size), at most every third frame, within 18–51. +6
  roughly halves a frame. Keyframes are coded 6 coarser, and the deltas after them sharpen
  the picture. A new bit rate takes effect from the next frame. Elsewhere it falls back to
  `variable`.
- **HEVC first.** The encoder probes `hvc1.1.6.L153.B0`, then H.264 High and Baseline, then
  VP9 and VP8. Web viewers list them in that order, and each browser lists only what its
  decoder takes. On the benchmark's page at the same quality, HEVC sent 0.7 Mbit/s where
  H.264 sent 2.8. The iOS app still asks for H.264.
- **Slow start.** A viewer's rate starts at 1.5 Mbit/s and climbs 25 % per step until the link
  first shows a queue, then 8 %. The first picture is sized for that rate (`video-scale.ts`),
  and a step back up jumps straight to the largest picture the link carries with 50 % spare.

| Link (120 ms, 30 ms jitter) | Median fps, before → after | p10 after             |
| --------------------------- | -------------------------- | --------------------- |
| 0.75 Mbit/s                 | 11 → 54–60                 | 21–29 (first seconds) |
| 1 Mbit/s                    | 17 → 60                    | 49–52                 |
| 1.5 Mbit/s                  | 39 → 59                    | 54                    |
| 25 Mbit/s                   | 60 → 60                    | 59                    |

### Consequences

- `check:perf` runs `video-link.ts` and fails below a 55 fps median or a 45 fps p10 on the
  default link (25 Mbit/s, 120 ms, 30 ms jitter). `frame-wire.ts`, `video-wire.ts`, `crisp.ts`
  and the JPEG fanout bench are gone with the JPEG viewer path.
- The JPEG screencast no longer runs while only viewers watch, which saves Chrome a JPEG encode
  per frame next to the video encode.
- A client without WebCodecs H.264 (or VP8/VP9 for the browser) sees no live picture.

## The desktop's encoder

Amended 2026-10-20. Remote viewers of a page the desktop's embedded backend hosts (an Electron
view, ADR 0085) get video too, from the same encoder code as ace's Chrome, run by the desktop
app. There is no JPEG-only backend left on the desktop.

- **Capture.** The desktop keeps one hidden encoder page while anyone watches a view as video: a
  `WebContentsView` in no window (it never counts as an app window), in an in-memory partition of
  its own, at `app://video-encoder/` (the app scheme is a secure context, which `getUserMedia`
  needs). A view is captured with `webContents.getMediaSourceId(encoderPage)` and
  `getUserMedia({ chromeMediaSource: "tab" })`: Chromium's own tab capture, with no user gesture,
  no picker and no macOS screen-recording permission. Electron asks the captured view's session
  for that `media` permission, from the encoder's origin; the views' sessions, which refuse every
  permission, allow exactly that one. The page goes 30 s after its last capture.
- **Encoder.** The page loads `video-extension/offscreen.ts` (`@ace/browser/video-encoder`), so
  configurations, pacing, the watchdog and keyframes are the extension's. It reports through a
  preload function (`aceVideoEmit`) with each chunk's bytes as they are, not base64.
- **Commands.** The daemon drives a capture with `ace.video.*` (`supported`, `start`, `encodes`,
  `keyframe`, `audio`, `stop`) on the tab's own relayed CDP, so each reaches the view it names,
  shown or not. The desktop offers this as the optional `video` capability in
  `browser.backend.register`; a desktop without it gives remote viewers no picture (live views are video only).
- **Transport.** Encoder events reach the daemon as binary WebSocket messages on the backend
  socket: `aceV`, a header length, the event as JSON (the extension's event, parsed with the same
  schema as ace's Chrome), then the chunk's bytes. The daemon's browser socket service takes
  binary messages before the files channel. Chunks never close or queue on the socket: while it
  holds more than 1 MiB, a chunk is dropped, the encode's later deltas are dropped until a
  keyframe gets through, and the encoder is asked for one (`video-gate.ts`). A capture's end or
  failure always goes.
- **Rendering.** A captured view renders unthrottled, parked when nobody shows it, as for a
  screencast (`throttle.ts`).
- **No sound.** The capture takes the picture only. Capturing a view's sound diverts it from the
  desktop's speakers: with a tone playing, macOS's speaker assertion for the page ended as the
  capture with audio started and stayed without it. The person at the desktop hears the page;
  remote viewers of desktop views get no sound until a capture can duplicate the sound
  instead.

Measured with `apps/desktop/e2e/browser-video.e2e.ts` (Electron 44, Apple M-series, the page
redrawing a canvas every frame, the view unseen): 60.0 fps at 1280 × 720 (2.8 Mbit/s) and
60.2 fps at 2560 × 1440 (8.4 Mbit/s), hardware H.264 throughout.

## Use my Chrome's encoder

Amended 2026-10-20. Remote viewers of a tab in the person's own Chrome (ADR 0084) get video, at
60 fps, without anything new in the person's browser.

- **Pictures, not tab capture.** ace's video extension is not in the person's Chrome and must not
  be (ADR 0084 forbids writing into their profile). The tab's own CDP screencast already reaches
  the daemon through ace for Chrome (`chrome.debugger`, native messaging, the host's socket). The
  live capture asks for it at the encode size, JPEG quality 80, at most 1920 px on the long side,
  as for a private context, and hands every frame to the encoder.
- **An encoder-only Chrome.** ace's browser service runs one more Chrome for Testing that only
  encodes: its own profile (`<dataDir>/browser/encoder`), no tabs of ace's, the video extension's
  offscreen document decoding and encoding the pictures (`ChromeVideo.openPictures`). It starts
  when a viewer first watches such a tab (the codec probe or the capture) and stops 30 s after
  its last capture ends; an agent working the person's tab with nobody watching starts nothing.
  A crashed encoder ends its captures and the next capture starts another. The `user` backend
  reaches it through an injected `videoEncoder` port, never through ace's Chrome backend.
- **No sound.** The person's browser plays its own; viewers get no sound here.

- **Pictures too large to relay.** The native host drops a message over the daemon socket's
  1 MiB, and Chrome stops screencasting while frames go unacknowledged: after a few dropped
  frames the picture froze for good. ace for Chrome now acknowledges a screencast frame over
  1 MiB − 16 KiB itself and leaves it out (`unrelayableFrame`), so the screencast goes on and the
  next picture that fits reaches ace. Only noise-like content gets there: a 1920 × 1080 page of
  random pixels at quality 80.

Measured with `packages/browser-extension/src/my-chrome-video.process.test.ts` (the real
extension and native host in a headless Chrome for Testing 153 as the person's browser, its
window 2100 × 1400, Apple M-series):

| Page, tab size              | Screencast frame (base64) | Relay frames/s | Video fps | Bit rate   |
| --------------------------- | ------------------------- | -------------- | --------- | ---------- |
| Scrolling text, 640 × 400   | —                         | 60             | 60        | 0.9 Mbit/s |
| Scrolling text, 1280 × 800  | 62 KiB                    | 60             | 60        | 3.6 Mbit/s |
| Scrolling text, 1920 × 1080 | 127 KiB                   | 60             | 59–60     | 5.3 Mbit/s |
| Random noise, 1280 × 800    | 273 KiB                   | 60             | 60        | —          |
| Random noise, 1920 × 1080   | over 1 MiB                | 0 (skipped)    | 0         | —          |

The relay is not the limit up to the 1 MiB message size: about 16 MB/s of base64 crossed
extension, native host and socket without a dropped frame. While encoding, the encoder Chrome
ran 10 processes using 30–60 % of one core; it exits 30 s after the last viewer leaves.

Limits:

- The screencast is a picture of the tab's window. An agent tab sized larger than the ace window
  it sits in comes out at the window's size, and the encoder scales it up (blurred). In an
  800 × 600 headless window a 1280 × 800 tab gave 756 × 413 pictures.
- An agent tab sits in an unfocused window of the person's; a Chrome that stops painting an
  occluded or minimized window sends no screencast frames, and the viewer's picture holds still.
- A page whose every picture is over 1 MiB (full-screen noise or video grain at 1920 px) shows
  no live picture until its pictures fit again.
