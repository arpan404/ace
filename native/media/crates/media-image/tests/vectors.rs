// SPDX-License-Identifier: Apache-2.0
//! Replays `vectors/image/cases.json`: each job's answer and, for pixels, what they look like.
use media_image::{Done, Failed, Input, run};
use media_wire::image::{DoneFormat, ImageOp};
use serde_json::Value;
use std::path::PathBuf;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../vectors/image")
}

type Error = Box<dyn std::error::Error>;
/// A case's input: its bytes, and its size when they are raw RGBA.
type File = (Vec<u8>, Option<(u32, u32)>);

fn rgba(done: &Done) -> Result<Vec<u8>, Error> {
    Ok(match done.format {
        DoneFormat::Rgba => done.bytes.clone(),
        DoneFormat::Jpeg | DoneFormat::Png => {
            media_image::pixels(&Input::Encoded(&done.bytes), u32::MAX)
                .map_err(|f| f.message)?
                .data
        }
        DoneFormat::Alpha | DoneFormat::None => return Err("no pixels".into()),
    })
}

fn check(case: &Value, result: Result<Done, Failed>) -> Result<(), Error> {
    let name = case["name"].as_str().unwrap_or("?");
    if let Some(reason) = case.get("failed") {
        let failed = match result {
            Ok(done) => return Err(format!("{name}: expected {reason}, got {done:?}").into()),
            Err(failed) => failed,
        };
        assert_eq!(serde_json::to_value(failed.reason)?, *reason, "{name}");
        assert!(!failed.message.is_empty(), "{name}: a refusal says why");
        return Ok(());
    }
    let done = result.map_err(|f| format!("{name}: {:?} {}", f.reason, f.message))?;
    let expected = &case["done"];
    assert_eq!(
        u64::from(done.width),
        expected["width"].as_u64().unwrap_or(0),
        "{name}"
    );
    assert_eq!(
        u64::from(done.height),
        expected["height"].as_u64().unwrap_or(0),
        "{name}"
    );
    assert_eq!(
        serde_json::to_value(done.format)?,
        expected["format"],
        "{name}"
    );
    if let Some(source) = expected.get("source") {
        assert_eq!(serde_json::to_value(done.source)?, *source, "{name}");
    }
    let width = done.width as usize;
    for check in case["alpha"].as_array().into_iter().flatten() {
        let (x, y) = (
            check[0].as_u64().unwrap_or(0) as usize,
            check[1].as_u64().unwrap_or(0) as usize,
        );
        assert_eq!(
            u64::from(done.bytes[y * width + x]),
            check[2].as_u64().unwrap_or(0),
            "{name} ({x}, {y})"
        );
    }
    if let Some(checks) = case["pixels"].as_array() {
        let pixels = rgba(&done)?;
        for check in checks {
            let (x, y) = (
                check[0].as_u64().unwrap_or(0) as usize,
                check[1].as_u64().unwrap_or(0) as usize,
            );
            let tolerance = check[3].as_i64().unwrap_or(0);
            let at = (y * width + x) * 4;
            let got = &pixels[at..at + 4];
            for (c, want) in check[2].as_array().into_iter().flatten().enumerate() {
                let diff = (i64::from(got[c]) - want.as_i64().unwrap_or(0)).abs();
                assert!(
                    diff <= tolerance,
                    "{name} ({x}, {y}): {got:?} against {}",
                    check[2]
                );
            }
        }
    }
    Ok(())
}

#[test]
fn every_image_vector_answers_as_recorded() -> Result<(), Error> {
    let cases: Value = serde_json::from_slice(&std::fs::read(root().join("cases.json"))?)?;
    let cases = cases["cases"].as_array().ok_or("no cases")?;
    assert!(cases.len() >= 20);
    for case in cases {
        let files: Vec<File> = case["inputs"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|input| {
                let (name, size) = match input.as_str() {
                    Some(name) => (name, None),
                    None => (
                        input["rgba"].as_str().unwrap_or(""),
                        Some((
                            input["width"].as_u64().unwrap_or(0) as u32,
                            input["height"].as_u64().unwrap_or(0) as u32,
                        )),
                    ),
                };
                Ok((std::fs::read(root().join("inputs").join(name))?, size))
            })
            .collect::<Result<_, Error>>()?;
        let inputs: Vec<Input> = files
            .iter()
            .map(|(bytes, size)| match size {
                Some((width, height)) => Input::Rgba {
                    data: bytes,
                    width: *width,
                    height: *height,
                },
                None => Input::Encoded(bytes),
            })
            .collect();
        let op: ImageOp = serde_json::from_value(case["op"].clone())?;
        check(case, run(&inputs, &op, &|| false))?;
    }
    Ok(())
}

#[test]
fn every_op_past_its_deadline_stops_with_deadline_before_any_work() -> Result<(), Error> {
    let jpeg = std::fs::read(root().join("inputs/red-64x48.jpg"))?;
    // Probe, the planar JPEG fit, the general fit and alpha each check the clock first.
    for op in [
        serde_json::json!({ "op": "probe", "maxPixels": 4096 }),
        serde_json::json!({ "op": "fit", "maxPixels": 4096, "width": 8, "height": 8,
            "autoOrient": false, "output": { "format": "jpeg", "quality": 80 } }),
        serde_json::json!({ "op": "fit", "maxPixels": 4096, "width": 8, "height": 8,
            "autoOrient": false, "output": { "format": "png" } }),
        serde_json::json!({ "op": "alpha", "maxPixels": 4096 }),
    ] {
        let op: ImageOp = serde_json::from_value(op)?;
        let asked = std::cell::Cell::new(0);
        let failed = run(&[Input::Encoded(&jpeg)], &op, &|| {
            asked.set(asked.get() + 1);
            true
        })
        .err()
        .ok_or("ran")?;
        assert_eq!(failed.reason, media_image::ImageFailure::Deadline);
        assert_eq!(asked.get(), 1, "{op:?} asked the clock after starting work");
    }
    Ok(())
}
