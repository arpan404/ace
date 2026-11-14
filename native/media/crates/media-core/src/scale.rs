// SPDX-License-Identifier: Apache-2.0
//! The frame rate and picture size ladder, matching video-scale.ts (ADR 0149, as the plan's 3G
//! section refines it): a measured thin link loses frames down to 15 fps at full size, then
//! shrinks at 15 fps no smaller than `READABLE_SIDE`, then drops to 8 and 5 fps, then shrinks
//! further; while the rate is still probing the picture shrinks first. Every step keeps a keyframe within half a second of the link. All
//! times are caller-supplied monotonic milliseconds; the ladder lives inline, so no update
//! allocates.
pub const KEEP_FRAMES_BPP: f64 = 0.02;
pub const FRAME_RATES: [f64; 5] = [60.0, 30.0, 15.0, 8.0, 5.0];
pub const KEYFRAME_BPP: f64 = 0.25;
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
pub fn frames_bpp(fps: f64) -> f64 {
    KEEP_FRAMES_BPP * (60.0 / fps).sqrt()
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
    up_since: Option<f64>,
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
                self.up_since = None;
                self.down_since = None;
                return ladder.steps[self.level];
            }
        };
        let now = input.now;
        if self.level < ladder.len - 1 && !carries(ladder.steps[self.level], 1.0) {
            self.up_since = None;
            let since = *self.down_since.get_or_insert(now);
            if now - since >= 1000.0 {
                self.level = fitting(&ladder, 1.0);
                self.down_since = None;
            }
            return ladder.steps[self.level];
        }
        self.down_since = None;
        let roomy = fitting(&ladder, 1.5);
        if roomy < self.level {
            let since = *self.up_since.get_or_insert(now);
            if now - since >= 3000.0 {
                self.level = roomy;
                self.up_since = None;
            }
        } else {
            self.up_since = None;
        }
        ladder.steps[self.level]
    }
}
