// SPDX-License-Identifier: Apache-2.0
//! The frame rate and picture size ladder, matching video-scale.ts (ADR 0149): a measured thin
//! link loses frames (60, 30, 15, 8, 5 fps) before pixels; while the rate is still probing the
//! picture shrinks first. Every step keeps a keyframe within half a second of the link. All
//! times are caller-supplied monotonic milliseconds; the ladder lives inline, so no update
//! allocates.
pub const KEEP_FRAMES_BPP: f64 = 0.02;
pub const FRAME_RATES: [f64; 5] = [60.0, 30.0, 15.0, 8.0, 5.0];
pub const KEYFRAME_BPP: f64 = 0.25;
pub const KEYFRAME_SECONDS: f64 = 0.5;
const SIZE_STEP: f64 = 0.84;
const SIZE_STEPS: i32 = 6;
const MAX_STEPS: usize = 12;
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Step {
    pub scale: f64,
    pub fps: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct PictureLink {
    pub link: f64,
    pub pixels: f64,
    pub fps: f64,
    pub now: f64,
    pub probing: bool,
}
pub fn frames_bpp(fps: f64) -> f64 {
    KEEP_FRAMES_BPP * (60.0 / fps).sqrt()
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
    fn new(fps: f64, probing: bool) -> Self {
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
        let lowest = rates[count - 1];
        let smallest = SIZE_STEP.powi(SIZE_STEPS);
        if probing {
            for level in 0..=SIZE_STEPS {
                ladder.push(SIZE_STEP.powi(level), fps);
            }
            for rate in &rates[1..count] {
                ladder.push(smallest, *rate);
            }
        } else {
            for rate in &rates[..count] {
                ladder.push(1.0, *rate);
            }
            for level in 1..=SIZE_STEPS {
                ladder.push(SIZE_STEP.powi(level), lowest);
            }
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
    ladder: Option<(f64, bool, Ladder)>,
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
        let ladder = match self.ladder {
            Some((fps, probing, ladder)) if fps == input.fps && probing == input.probing => ladder,
            _ => {
                let ladder = Ladder::new(input.fps, input.probing);
                self.ladder = Some((input.fps, input.probing, ladder));
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
