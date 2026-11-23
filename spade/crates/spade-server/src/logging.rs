//! What Spade's log may hold. Two crates' own diagnostics are dropped whatever `RUST_LOG` says:
//! the HTML parser's carry page text, and the model SDK's errors carry the response bodies of
//! failed calls, which an endpoint may fill with the key or sign-in token it was sent (ADR 0119,
//! ADR 0214). Spade logs its own, sanitized, account of every failed call instead.

/// Whether an event from `target` may be logged at all.
pub fn kept(target: &str) -> bool {
    !spade_fetch::is_parser_log(target) && !is_model_sdk(target)
}

fn is_model_sdk(target: &str) -> bool {
    target == "genai" || target.starts_with("genai::")
}

#[cfg(test)]
mod tests {
    use super::kept;

    #[test]
    fn the_model_sdks_diagnostics_are_never_kept_and_spades_are() {
        for dropped in ["genai", "genai::adapter::adapters::openai_resp::streamer"] {
            assert!(!kept(dropped), "{dropped}");
        }
        for shown in ["spade_server::engine", "genaissance", "spade_models"] {
            assert!(kept(shown), "{shown}");
        }
    }
}
