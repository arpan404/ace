//! What replies cost and whether today's cap allows another.

use spade_models::{Price, Usage};

/// The cost of `usage` at `price`, in millionths of a US dollar. No price (a flat-rate plan or a
/// local server) costs nothing. Input read from the cache is charged at the cache-read price and
/// input written to it at the cache-write price; each falls back to the input price.
pub fn cost_micros(price: Option<Price>, usage: &Usage) -> u64 {
    let Some(price) = price else { return 0 };
    let count = |value: Option<u32>| f64::from(value.unwrap_or(0));
    let read = count(usage.cache_read_tokens);
    let write = count(usage.cache_write_tokens);
    let plain_input = (count(usage.input_tokens) - read - write).max(0.0);
    // A price per million tokens is the same number as millionths of a dollar per token.
    let micros = plain_input * price.input
        + read * price.cache_read.unwrap_or(price.input)
        + write * price.cache_write.unwrap_or(price.input)
        + count(usage.output_tokens) * price.output;
    if micros.is_finite() && micros > 0.0 {
        micros.round() as u64
    } else {
        0
    }
}

/// What one image or transcription call cost (ADR 0134): its tokens at the token prices, plus the
/// model's price per call.
pub fn call_cost_micros(price: Option<Price>, usage: &Usage) -> u64 {
    let per_call = price.and_then(|p| p.per_call).map_or(0, usd_to_micros);
    cost_micros(price, usage).saturating_add(per_call)
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
        let usage = Usage {
            input_tokens: Some(1_000),
            output_tokens: Some(500),
            ..Usage::default()
        };
        // 1,000 × $2/M + 500 × $10/M = $0.002 + $0.005 = 7,000 micros.
        assert_eq!(cost_micros(Some(sonnet()), &usage), 7_000);
    }

    #[test]
    fn a_flat_rate_route_and_missing_counts_cost_nothing() {
        let usage = Usage {
            input_tokens: Some(1_000),
            output_tokens: Some(1_000),
            ..Usage::default()
        };
        assert_eq!(cost_micros(None, &usage), 0);
        assert_eq!(cost_micros(Some(sonnet()), &Usage::default()), 0);
    }

    /// Claude Sonnet 5.5's listed price.
    fn sonnet() -> Price {
        Price {
            input: 2.0,
            output: 10.0,
            cache_read: Some(0.1),
            cache_write: Some(2.5),
            per_call: None,
            per_search: None,
        }
    }

    #[test]
    fn an_image_call_costs_its_tokens_and_its_price_per_call() {
        let price = Price {
            per_call: Some(0.04),
            per_search: None,
            ..sonnet()
        };
        let usage = Usage {
            input_tokens: Some(100),
            output_tokens: Some(1_000),
            ..Usage::default()
        };
        // 100 × 2 + 1,000 × 10 = 10,200 micros, plus 40,000 for the call.
        assert_eq!(call_cost_micros(Some(price), &usage), 50_200);
        assert_eq!(call_cost_micros(None, &usage), 0);
    }

    #[test]
    fn cached_input_is_charged_at_the_cache_prices() {
        let usage = Usage {
            input_tokens: Some(30_000),
            output_tokens: Some(200),
            cache_read_tokens: Some(29_000),
            cache_write_tokens: Some(700),
        };
        // 300 plain × 2 + 29,000 read × 0.1 + 700 written × 2.5 + 200 out × 10
        // = 600 + 2,900 + 1,750 + 2,000 = 7,250 micros.
        assert_eq!(cost_micros(Some(sonnet()), &usage), 7_250);
    }

    #[test]
    fn without_cache_prices_cached_input_costs_the_input_price() {
        let price = Price {
            input: 2.0,
            output: 10.0,
            cache_read: None,
            cache_write: None,
            per_call: None,
            per_search: None,
        };
        let usage = Usage {
            input_tokens: Some(1_000),
            cache_read_tokens: Some(900),
            ..Usage::default()
        };
        assert_eq!(cost_micros(Some(price), &usage), 2_000);
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
