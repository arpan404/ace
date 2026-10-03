use crate::{
    coordinates::Bounds,
    errors::{Code, Result},
};
use serde::Serialize;
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub fallback: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds_centre: Option<Point>,
}
#[derive(Debug, Serialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}
/// Provider failures never authorize synthesized input. Only absence of a semantic pattern does.
pub fn complete(result: Result<()>, fallback: impl FnOnce() -> Result<Bounds>) -> Result<Outcome> {
    match result {
        Ok(()) => Ok(Outcome {
            fallback: false,
            method: None,
            bounds_centre: None,
        }),
        Err(error) if error.code == Code::NotSupported => {
            let centre = fallback()?;
            Ok(Outcome {
                fallback: true,
                method: Some("input"),
                bounds_centre: Some(Point {
                    x: centre.x,
                    y: centre.y,
                }),
            })
        }
        Err(error) => Err(error),
    }
}
