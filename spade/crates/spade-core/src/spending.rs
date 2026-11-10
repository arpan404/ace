//! What replies cost and whether today's cap allows another.

use spade_models::{Price, Usage};

/// The cost of `usage` at `price`, in millionths of a US dollar. No price (a flat-rate plan)
/// costs nothing.
pub fn cost_micros(price: Option<Price>, usage: &Usage) -> u64 {
    let Some(price) = price else { return 0 };
    let tokens = |count: Option<u32>| f64::from(count.unwrap_or(0));
    // A price per million tokens is the same number as millionths of a dollar per token.
    let micros =
        tokens(usage.input_tokens) * price.input + tokens(usage.output_tokens) * price.output;
    if micros.is_finite() && micros > 0.0 {
        micros.round() as u64
    } else {
        0
    }
}

/// Dollars as millionths of a dollar.
pub fn usd_to_micros(usd: f64) -> u64 {
    if usd.is_finite() && usd > 0.0 {
        (usd * 1_000_000.0).round() as u64
    } else {
        0
    }
}

/// Whether another reply may start after `spent` today, under `cap`.
pub fn within_cap(spent_micros: u64, cap_micros: u64) -> bool {
    spent_micros < cap_micros
}

/// The start of the local day containing `now_ms`, for a clock `offset_seconds` east of UTC.
pub fn day_start_ms(now_ms: i64, offset_seconds: i32) -> i64 {
    const DAY: i64 = 86_400_000;
    let offset = i64::from(offset_seconds) * 1000;
    (now_ms + offset).div_euclid(DAY) * DAY - offset
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reply_costs_its_tokens_at_the_route_price() {
        let price = Price {
            input: 2.0,
            output: 10.0,
        };
        let usage = Usage {
            input_tokens: Some(1_000),
            output_tokens: Some(500),
        };
        // 1,000 × $2/M + 500 × $10/M = $0.002 + $0.005 = 7,000 micros.
        assert_eq!(cost_micros(Some(price), &usage), 7_000);
    }

    #[test]
    fn a_flat_rate_route_and_missing_counts_cost_nothing() {
        let usage = Usage {
            input_tokens: Some(1_000),
            output_tokens: Some(1_000),
        };
        assert_eq!(cost_micros(None, &usage), 0);
        let price = Some(Price {
            input: 2.0,
            output: 10.0,
        });
        assert_eq!(cost_micros(price, &Usage::default()), 0);
    }

    #[test]
    fn the_cap_blocks_once_reached() {
        let cap = usd_to_micros(5.0);
        assert!(within_cap(4_999_999, cap));
        assert!(!within_cap(5_000_000, cap));
    }

    #[test]
    fn the_local_day_starts_at_local_midnight() {
        // 2026-11-09T03:00:00Z is still 2026-11-08 in Chicago (UTC-6).
        let now = 1_794_193_200_000;
        let chicago = -6 * 3600;
        assert_eq!(day_start_ms(now, chicago), 1_794_117_600_000); // 2026-11-08T06:00:00Z
        assert_eq!(day_start_ms(now, 0), 1_794_182_400_000); // 2026-11-09T00:00:00Z
    }
}
