//! When to store a reply's progress: at most once per interval, so a restart loses little and
//! the log does not grow with every token.

#[derive(Debug, Clone)]
pub struct Checkpoints {
    interval_ms: i64,
    last_ms: i64,
}

impl Checkpoints {
    pub const INTERVAL_MS: i64 = 500;

    pub fn new(started_ms: i64) -> Self {
        Self {
            interval_ms: Self::INTERVAL_MS,
            last_ms: started_ms,
        }
    }

    /// Whether to store a checkpoint now; if so, the interval restarts.
    pub fn due(&mut self, now_ms: i64) -> bool {
        if now_ms - self.last_ms >= self.interval_ms {
            self.last_ms = now_ms;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoints_come_at_most_once_per_interval() {
        let mut checkpoints = Checkpoints::new(1_000);
        let due: Vec<i64> = [1_100, 1_499, 1_500, 1_700, 1_999, 2_000, 2_600]
            .into_iter()
            .filter(|now| checkpoints.due(*now))
            .collect();
        assert_eq!(due, vec![1_500, 2_000, 2_600]);
    }
}
