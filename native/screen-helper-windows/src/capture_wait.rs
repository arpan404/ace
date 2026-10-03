/// One pending frame signal. Deferred pacing retains it even if no further event arrives.
#[derive(Default)]
pub struct Pending {
    arrived: bool,
}
#[derive(Debug, PartialEq)]
pub enum Wait {
    Idle,
    After(f64),
    Frame,
}
impl Pending {
    pub fn arrived(&mut self) {
        self.arrived = true;
    }
    pub fn next(&mut self, delay_ms: f64) -> Wait {
        if !self.arrived {
            Wait::Idle
        } else if delay_ms > 0.0 {
            Wait::After(delay_ms)
        } else {
            self.arrived = false;
            Wait::Frame
        }
    }
}
