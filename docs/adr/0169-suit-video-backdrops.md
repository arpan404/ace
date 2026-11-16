# 0169: A Suit can play a video, and ace's accent follows its colours

Date: 2026-11-15. Status: proposed.
Extends [ADR 0150](0150-suits.md) (Suits). Keeps 0150's sandbox, guard and checks as they are.

## Context

The owner wants a Suit built on a music video: the video plays behind ace with its sound, and
ace's colours move with the picture. Under 0150 a Suit's backdrop is a canvas scene in a sandbox
whose policy is `default-src 'none'`. The daemon serves no media, files are read whole into
memory under a 20 MB asset cap, and a scene can't change ace's tokens. A canvas scene could draw
video frames only if the sandbox allowed media, and a frame from a video taints the canvas, so
the live check could no longer read it.

## Decision

### The video is ace's, not the scene's

A Suit names a video in `suit.json`. ace plays it in its own `<video>` element behind the shell,
where the app scene would sit. No Suit code runs for it: the sandbox, its policy and the scene
runtime don't change, and a Suit with a video has no `app` scene (a region's scene still runs).

```json
"video": {
  "sources": ["assets/clip-2160.mp4", "assets/clip-1080.mp4"],
  "poster": "assets/clip-still.webp",
  "fit": "cover",
  "audio": { "muted": false, "volume": 0.6 },
  "palette": { "accent": true, "tint": 0.12 }
}
```

- `sources`: one to three renditions of one video (`.mp4`, `.m4v`, `.mov`, `.webm` under
  `assets/`). ace reads each file's real size from its metadata and plays the smallest one that
  covers the window in device pixels, the largest when none does. It picks again when the window
  settles at a new size or moves to a display with another pixel ratio, and the new rendition
  carries on from the same moment. A 4K file plays as 4K only on a
  window that can show it, and Settings says the size that plays. ace never upscales a picture or
  calls it 4K; it shows what the file holds.
- `poster`: a still image in `assets/`. It shows before the first frame, and in the video's place
  whenever the video can't play (out of the page's reach, or dropped after failing).
- `audio.muted` turns the sound off from the Suit itself, and `volume` caps it (0–1). ace has no
  audio control of its own in the UI.
- `palette`: what ace takes from the picture (below). Absent means both on at their defaults.

### Files: streamed, never read whole

- Video files are exempt from the 20 MB asset total. Each may be up to 8 GiB; a Suit holds at
  most three.
- The reader never reads them. The content hash frames each one by path, size and modification
  time, so a changed file still makes a new version, and a 4K file is not hashed on every save.
- `GET` of a video's URL streams from the file with byte ranges (`206`, `416`). It is opened
  with no link anywhere on its path: after the open, every folder on the way is checked to be a
  real folder and the name to still be the opened file, since `O_NOFOLLOW` guards only the last
  name. Every other Suit file is read the same way. Grants, CORS, `nosniff` and the file policy are those of every other
  asset. The app's policy allows media from loopback daemons, as it allows their images.

### Colours from the picture, bounded

Twice a second while the video plays, ace draws the frame into a 16 × 9 canvas, picks the
picture's strongest colour (saturation-weighted, mid-lightness, most common hue) and eases
toward it in OKLab. From that colour:

- `palette.accent`: the accent tokens (`--ring`, its hover, pressed, label and text) come from
  `deriveAccent`, as when a person picks an accent: labels on it read at AA, it stands 3:1 off the
  page, links read on every surface, and it is moved away from every status colour.
- `palette.tint` (0–0.25, default 0.12): the veil between the video and the UI takes that much
  of the colour, and less when ace's text would drop under 4.5:1 on it.

Status colours, row status, the danger fill, the approval strip and every other protected part
are untouched: the sampler writes only the accent tokens and the veil's colour. The veil's
opacity stays held by 0150's reveal ceiling, so text reads over any frame. Under Reduce motion
the colour is taken once, from the poster or first frame, and held. A frame ace can't read (the
page couldn't load the video with CORS) leaves the Suit's own colours in place.

### When it plays

- Plays only while the window is visible. A hidden window pauses it; it resumes at the same
  moment. Blur doesn't pause it, so music keeps playing while the person works in another app
  beside ace.
- Reduce motion (`backdropMotion: "still"`) and saving power pause the video on the frame it
  shows, so the backdrop doesn't jump to another picture; before any frame has loaded that is the
  poster.
- A browser that blocks autoplay with sound starts it muted and turns the sound on at the
  person's first click or key press in the page.
- The position is kept per version of the Suit, so a reload, reconnect or daemon restart picks up
  where it was. A video that fails three times, with no five seconds of picture played between
  failures, is dropped for that version, and the Suit carries on with its poster and colours.
  Metadata loading doesn't forgive failures, so a file that reads but won't decode can't retry
  forever.

### Checked like a scene

The live check samples the video's frame as it samples a scene's canvas, and text over a frame it
can't read is listed as unchecked. The static checks refuse a video that's missing, too large,
not a video type, or a Suit with both a video and an app scene.

### Privacy

A Suit's files stay in the person's `~/.ace/suits`. Nothing about the video leaves the daemon
except to the person's own signed-in devices, over the URL grants 0150 already uses. ace ships
no third-party footage, and the make-a-suit skill tells agents to use only media the person
supplies and never to fetch it from a streaming site.

## Consequences

- One `<video>` element and one 16 × 9 read twice a second; decoding is the browser's hardware
  path. A 4K video costs a 4K decode, so ace picks a smaller rendition when there is one.
- No new code runs in ace's page for a Suit; the video is data.
- Phones still don't read Suits (0150).
