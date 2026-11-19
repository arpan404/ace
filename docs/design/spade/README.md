# Spade mark

Spade's face: a round head with two egg-shaped eyes that glance down a little shyly. `spade-mark.html` in this folder is the living reference. Open it in a browser to see every mood, the blink and the eyes following the pointer. The web app draws the resting mark in `apps/web/src/components/spade-mark.tsx` (ADR 0107).

## Geometry (24-unit grid)

- **Head:** circle at (12, 12), r 10.6, in the current text colour.
- **Face:** the eyes and pupils rotate −4° around (12, 12).
- **Eyes:** egg-shaped (flatter on top), centred at (8.7, 11.9) and (15.3, 11.9), rx 2.3, ry 3.55. The egg path is `egg()` in the reference.
- **Outline:** a second egg, larger by `ring` on each radius, drawn behind the eye.
  - `ring` is 1.15 at 24px and below, 0.85 up to 40px, and 0.62 above that.
- **Pupils:** ellipses, rx 1.1 and ry 1.6.
  - At 24px and below they grow to rx 1.25 and ry 1.8.
  - For Needs you they are rx 1.35 and ry 1.85.
- **Pupil rest:** offset (−0.25, +2) from the eye centre, kept inside the eye. The clamp scales the offset onto an ellipse of radii (eye − pupil − pad), with pad 0.22, or 0.02 when small.
- **Catchlight:** a circle of r = 0.3 × pupil rx, at pupil + (0.38 rx, −0.42 ry). It is dropped at 24px and below.

## Colour

Monochrome.

- **Eyes:** always paper `#f6f6f7`, with outline and pupils near-black `#141416`, whatever the theme.
- **Head:** follows the theme. It is light in dark mode and becomes a dark ball with white eyes in light mode.
- **Marks drawn on the head:** the Done smile and the Working lid line take the colour opposite the head, so they read in both modes.

## Moods

| Mood      | Eyes                                                                    |
| --------- | ----------------------------------------------------------------------- |
| Idle      | Resting look, blinks now and then                                       |
| Thinking  | Pupils up and to the right (+0.7, −1.3)                                 |
| Working   | Flat upper lids down to the eye centre, pupils looking down at the work |
| Needs you | Bigger pupils looking straight out, and the whole mark hops             |
| Done      | Closed, smiling arcs (^ ^)                                              |

## Motion

- **Blink:** every 5.2s, each eye scales to 8% height at 95.5% of the cycle around its own centre. The second eye is 30ms late, so it reads as natural.
- **Hop (Needs you):** a 1.3s loop on `cubic-bezier(.3, 1.5, .6, 1)`. The mark rises 1.2px with a slight stretch, then lands with a slight squash. The viewBox gets padding so the hop isn't clipped.
- **Follow the pointer:**
  - **Direction:** the pupils turn toward the pointer, rotated back by the face's tilt.
  - **Reach:** they move up to 2 units, scaled by the pointer's distance, and stay clamped inside the eye.
  - **Updates:** once per animation frame.
- **Reduced motion:** blinking, hopping and following all stop.

## Rules

- No colour, gradients or glows; the mark is monochrome.
- No card suit, no ace mark, no robot hardware: Spade is its own character.
- Use the small-size drawing at 24px and below; never just scale the large one down.
