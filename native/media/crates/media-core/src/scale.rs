// SPDX-License-Identifier: Apache-2.0
//! The frame rate and picture size ladder, matching video-scale.ts (ADR 0149, as the plan's 3G
//! section refines it): a measured thin link loses frames down to 15 fps at full size, then
//! shrinks at 15 fps no smaller than `READABLE_SIDE`, then drops to 8 and 5 fps, then shrinks
//! further; while the rate is still probing the picture shrinks first. Every step keeps a keyframe within half a second of the link. All
//! times are caller-supplied monotonic milliseconds; the ladder lives inline, so no update
//! allocates.
pub const KEEP_FRAMES_BPP: f64 = 0.02;
pub const FRAME_RATES: [f64; 5] = [60.0, 30.0, 15.0, 8.0, 5.0];
/// About this many bits a pixel per keyframe within `KEYFRAME_SECONDS` (video-scale.ts).
pub const KEYFRAME_BPP: f64 = 0.15;
pub const KEYFRAME_SECONDS: f64 = 0.5;
const SIZE_STEP: f64 = 0.84;
const SIZE_STEPS: i32 = 6;
const MAX_STEPS: usize = 12;
const STEADY_FPS: f64 = 15.0;
pub const READABLE_SIDE: f64 = 1152.0;
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Step {
    pub scale: f64,
    pub fps: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct PictureLink {
    pub link: f64,
    pub pixels: f64,
    /// The full picture's longer side in pixels; 0 when unknown (nothing shrinks at 15 fps).
    pub side: f64,
    pub fps: f64,
    pub now: f64,
    pub probing: bool,
}
/// Bits per pixel per frame a step needs: the same at every frame rate, as the quantizer keeps
/// every frame it is given (video-scale.ts).
pub fn frames_bpp(_fps: f64) -> f64 {
    KEEP_FRAMES_BPP
}
/// Size steps at 15 fps that keep a picture of this longer side at least `READABLE_SIDE`.
pub fn readable_steps(side: f64) -> usize {
    let mut steps = 0;
    while steps < SIZE_STEPS as usize && side * SIZE_STEP.powi(steps as i32 + 1) >= READABLE_SIDE {
        steps += 1;
    }
    steps
}
pub fn step_needs(pixels: f64, step: Step) -> f64 {
    let area = pixels * step.scale.powi(2);
    (area * step.fps * frames_bpp(step.fps)).max(area * KEYFRAME_BPP / KEYFRAME_SECONDS)
}
#[derive(Clone, Copy, Debug)]
struct Ladder {
    steps: [Step; MAX_STEPS],
    len: usize,
}
impl Ladder {
    fn new(fps: f64, probing: bool, readable: usize) -> Self {
        let mut ladder = Self {
            steps: [Step { scale: 1.0, fps }; MAX_STEPS],
            len: 0,
        };
        let mut rates = [fps; 5];
        let mut count = 1;
        for rate in FRAME_RATES.into_iter().filter(|r| *r < fps) {
            if count < rates.len() {
                rates[count] = rate;
                count += 1;
            }
        }
        let rates = &rates[..count];
        let size = |level: usize| SIZE_STEP.powi(level as i32);
        let smallest = size(SIZE_STEPS as usize);
        if probing {
            for level in 0..=SIZE_STEPS as usize {
                ladder.push(size(level), fps);
            }
            for rate in &rates[1..] {
                ladder.push(smallest, *rate);
            }
            return ladder;
        }
        let steady = rates.iter().filter(|r| **r >= STEADY_FPS).count();
        let kept = if steady == 0 { 0 } else { readable };
        let lowest = rates[count - 1];
        for rate in &rates[..steady] {
            ladder.push(1.0, *rate);
        }
        if steady > 0 {
            for level in 1..=kept {
                ladder.push(size(level), rates[steady - 1]);
            }
        }
        for rate in &rates[steady..] {
            ladder.push(size(kept), *rate);
        }
        for level in kept + 1..=SIZE_STEPS as usize {
            ladder.push(size(level), lowest);
        }
        ladder
    }
    fn push(&mut self, scale: f64, fps: f64) {
        self.steps[self.len] = Step { scale, fps };
        self.len += 1;
    }
}
#[derive(Default, Debug)]
pub struct PictureScale {
    level: usize,
    ladder: Option<(f64, bool, usize, Ladder)>,
    /// A larger picture the link carried with spare (level, since): its own timer.
    size_up: Option<(usize, f64)>,
    /// More frames at this size the link carried with spare (level, since).
    frames_up: Option<(usize, f64)>,
    down_since: Option<f64>,
}
impl PictureScale {
    pub fn update(&mut self, input: PictureLink) -> Step {
        let carries = |step: Step, spare: f64| input.link >= step_needs(input.pixels, step) * spare;
        let fitting = |ladder: &Ladder, spare: f64| {
            let mut level = 0;
            while level < ladder.len - 1 && !carries(ladder.steps[level], spare) {
                level += 1;
            }
            level
        };
        let readable = readable_steps(input.side);
        let ladder = match self.ladder {
            Some((fps, probing, kept, ladder))
                if fps == input.fps && probing == input.probing && kept == readable =>
            {
                ladder
            }
            _ => {
                let ladder = Ladder::new(input.fps, input.probing, readable);
                self.ladder = Some((input.fps, input.probing, readable, ladder));
                self.level = fitting(&ladder, 1.0);
                self.size_up = None;
                self.frames_up = None;
                self.down_since = None;
                return ladder.steps[self.level];
            }
        };
        let now = input.now;
        if self.level < ladder.len - 1 && !carries(ladder.steps[self.level], 1.0) {
            self.size_up = None;
            self.frames_up = None;
            let since = *self.down_since.get_or_insert(now);
            if now - since >= 1000.0 {
                self.level = fitting(&ladder, 1.0);
                self.down_since = None;
            }
            return ladder.steps[self.level];
        }
        self.down_since = None;
        // A larger picture (3 s at 1.5x spare) and more frames at this size (1 s at 1.2x) are
        // judged apart; each timer restarts when its target changes.
        let scale = ladder.steps[self.level].scale;
        let pending = |held: Option<(usize, f64)>, level: usize| match held {
            Some((l, since)) if l == level => (l, since),
            _ => (level, now),
        };
        let roomy = fitting(&ladder, 1.5);
        self.size_up = (roomy < self.level && ladder.steps[roomy].scale != scale)
            .then(|| pending(self.size_up, roomy));
        let mut frames = fitting(&ladder, 1.2);
        while frames < self.level && ladder.steps[frames].scale != scale {
            frames += 1;
        }
        self.frames_up = (frames < self.level).then(|| pending(self.frames_up, frames));
        let climb = match (self.size_up, self.frames_up) {
            (Some((level, since)), _) if now - since >= 3000.0 => Some(level),
            (_, Some((level, since))) if now - since >= 1000.0 => Some(level),
            _ => None,
        };
        if let Some(level) = climb {
            self.level = level;
            self.size_up = None;
            self.frames_up = None;
        }
        ladder.steps[self.level]
    }
}
