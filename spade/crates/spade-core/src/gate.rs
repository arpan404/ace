//! The approval gate: whether a tool call runs straight away or waits for the person.

use crate::tools::Risk;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Run,
    Ask,
}

/// Reads run. Destructive calls always ask. A write asks unless the person chose "always" for
/// that tool, and always asks in a turn that has read untrusted content (a web page or an email
/// may carry instructions written to trick Spade).
pub fn decide(risk: Risk, always_allowed: bool, untrusted_turn: bool) -> Decision {
    match risk {
        Risk::Read => Decision::Run,
        Risk::Destructive => Decision::Ask,
        Risk::Write if untrusted_turn => Decision::Ask,
        Risk::Write if always_allowed => Decision::Run,
        Risk::Write => Decision::Ask,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_gate_follows_risk_permission_and_taint() {
        let cases = [
            (Risk::Read, false, false, Decision::Run),
            (Risk::Read, false, true, Decision::Run),
            (Risk::Write, false, false, Decision::Ask),
            (Risk::Write, true, false, Decision::Run),
            (Risk::Write, true, true, Decision::Ask),
            (Risk::Destructive, true, false, Decision::Ask),
        ];
        for (risk, always, untrusted, expected) in cases {
            assert_eq!(
                decide(risk, always, untrusted),
                expected,
                "{risk:?} always={always} untrusted={untrusted}"
            );
        }
    }
}
