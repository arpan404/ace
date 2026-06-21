use crate::TerminalConfig;

pub fn append_bounded_history(history: &mut String, chunk: &str, config: &TerminalConfig) {
    history.push_str(chunk);
    if history.len() > config.history_byte_limit {
        let start = history.len().saturating_sub(config.history_byte_limit);
        *history = history[start..].to_string();
    }

    let line_count = history
        .as_bytes()
        .iter()
        .filter(|byte| **byte == b'\n')
        .count();
    if line_count <= config.history_line_limit {
        return;
    }

    let remove_lines = line_count - config.history_line_limit;
    let mut removed = 0;
    let mut split = 0;
    for (index, byte) in history.as_bytes().iter().enumerate() {
        if *byte == b'\n' {
            removed += 1;
            if removed >= remove_lines {
                split = index + 1;
                break;
            }
        }
    }
    *history = history[split..].to_string();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_history_by_line_and_byte_limits() {
        let config = TerminalConfig {
            history_line_limit: 2,
            history_byte_limit: 8,
            ..TerminalConfig::default()
        };
        let mut history = String::new();
        append_bounded_history(&mut history, "one\ntwo\nthree\n", &config);
        assert!(history.len() <= 8);
        assert!(history.ends_with("three\n"));
    }
}
