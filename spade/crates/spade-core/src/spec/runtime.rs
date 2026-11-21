//! The `runtime` part's regions: `spade.v1` as `spade_core::effect::runtime` holds it, the same
//! table the gate decides with and `spade/docs/runtime.md` is written from.

use super::conformance::LEVELS;
use super::markdown::level_cases;
use crate::effect::runtime;

pub fn regions() -> Vec<(&'static str, String)> {
    vec![
        (
            "version",
            format!(
                "This part names `spade.v{v}`: a package that needs it says `\"requires\": \
                 {{\"runtime\": \"{v}\"}}`.\n",
                v = runtime::VERSION
            ),
        ),
        ("modules", runtime::modules()),
        ("level-cases", level_cases(&[&LEVELS[0], &LEVELS[1]])),
        ("aliases", runtime::aliases()),
        (
            "internal",
            format!(
                "These names are a runtime's own and outside `spade.v{}`; a package MUST NOT \
                 rely on them: {}.\n",
                runtime::VERSION,
                runtime::internal()
            ),
        ),
    ]
}
