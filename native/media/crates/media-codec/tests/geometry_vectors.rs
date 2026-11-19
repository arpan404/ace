// SPDX-License-Identifier: Apache-2.0
use media_codec::{CodecError, Size, fit_size};
use serde::Deserialize;
#[derive(Deserialize)]
struct Dimensions {
    width: u32,
    height: u32,
}
impl Dimensions {
    fn size(&self) -> Size {
        Size {
            width: self.width,
            height: self.height,
        }
    }
}
#[derive(Deserialize)]
struct Viewer {
    viewport: Dimensions,
}
#[derive(Deserialize)]
struct Input {
    source: Dimensions,
    viewers: Vec<Viewer>,
}
#[derive(Deserialize)]
struct Output {
    capture: Dimensions,
}
#[derive(Deserialize)]
struct Scenario {
    input: Input,
    output: Output,
}
#[test]
fn source_and_largest_viewport_fit_to_the_shared_plans_even_capture()
-> Result<(), Box<dyn std::error::Error>> {
    // K1's scenario orders viewports largest first. It is below the scale and
    // maximum-side caps, so this exercises the shared geometry without owning
    // encode-sharing, rate or adaptive scale policy.
    let scenario: Scenario =
        serde_json::from_str(include_str!("../../../vectors/plan/scenarios.json"))?;
    let viewport = scenario
        .input
        .viewers
        .first()
        .ok_or(CodecError::InvalidInput("missing viewport".into()))?;
    assert_eq!(
        fit_size(scenario.input.source.size(), viewport.viewport.size())?,
        scenario.output.capture.size()
    );
    Ok(())
}
