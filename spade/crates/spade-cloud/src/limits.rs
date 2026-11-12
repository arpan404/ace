//! Request budgets, per account and per address: a token bucket each, in memory. Pure apart from
//! the time callers pass.

use std::collections::HashMap;

/// Most buckets kept before full ones are dropped (a full bucket is the same as none).
const MOST_BUCKETS: usize = 100_000;

#[derive(Debug, Clone, Copy)]
pub struct Budget {
    /// Requests allowed at once.
    pub burst: u32,
    /// One more request is allowed every this many ms.
    pub every_ms: u64,
}

struct Bucket {
    tokens: f64,
    at_ms: u64,
}

pub struct Limits {
    budget: Budget,
    buckets: HashMap<String, Bucket>,
}

impl Limits {
    pub fn new(budget: Budget) -> Self {
        Self {
            budget,
            buckets: HashMap::new(),
        }
    }

    /// Takes one request from `key`'s budget. `Err(seconds)`: none left; try again after that.
    pub fn take(&mut self, key: &str, now_ms: u64) -> Result<(), u64> {
        if self.buckets.len() >= MOST_BUCKETS {
            self.prune(now_ms);
        }
        let burst = f64::from(self.budget.burst);
        let every = self.budget.every_ms.max(1) as f64;
        let bucket = self.buckets.entry(key.to_owned()).or_insert(Bucket {
            tokens: burst,
            at_ms: now_ms,
        });
        let elapsed = now_ms.saturating_sub(bucket.at_ms) as f64;
        bucket.tokens = (bucket.tokens + elapsed / every).min(burst);
        bucket.at_ms = now_ms;
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            Ok(())
        } else {
            let wait_ms = (1.0 - bucket.tokens) * every;
            Err(((wait_ms / 1000.0).ceil() as u64).max(1))
        }
    }

    fn prune(&mut self, now_ms: u64) {
        let burst = f64::from(self.budget.burst);
        let every = self.budget.every_ms.max(1) as f64;
        self.buckets.retain(|_, bucket| {
            bucket.tokens + now_ms.saturating_sub(bucket.at_ms) as f64 / every < burst
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_gets_its_burst_then_waits_for_the_budget_to_refill() {
        let mut limits = Limits::new(Budget {
            burst: 3,
            every_ms: 2_000,
        });
        for _ in 0..3 {
            assert_eq!(limits.take("a", 0), Ok(()));
        }
        assert_eq!(limits.take("a", 0), Err(2));
        assert_eq!(
            limits.take("b", 0),
            Ok(()),
            "another key has its own budget"
        );
        assert_eq!(limits.take("a", 2_000), Ok(()));
        assert_eq!(limits.take("a", 2_000), Err(2));
    }
}
