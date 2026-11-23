//! Spade passes the Spade Agent Format's conformance suite at every level (ADR 0201 §5), through
//! the same doors any implementation is held to: its reader as `spade --conform`, its runtime
//! over its real HTTP API and as `spade --bot-test`, its surfaces over both.

mod support;

use spade_conform::http::Http;
use spade_conform::{Report, reader, runtime, surfaces};
use support::packaged::secured;
use support::{Result, TOKEN, guarded, person_stamp};

fn command(flag: &str) -> (std::ffi::OsString, Vec<std::ffi::OsString>) {
    (env!("CARGO_BIN_EXE_spade").into(), vec![flag.into()])
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn spade_passes_the_spade_agent_formats_conformance_suite_at_every_level() -> Result {
    let spade = secured(Vec::new(), Vec::new()).await?;
    let key = spade.person_key_path.clone();
    let http = Http::new(&spade.base, TOKEN).with_authentication(move |request| {
        let bytes = request.body().and_then(reqwest::Body::as_bytes);
        if let Some((target, value)) =
            guarded(request.method().as_str(), request.url().path(), bytes)
        {
            let stamp = person_stamp(&key, &target, &value).map_err(|e| e.to_string())?;
            request.headers_mut().insert(
                spade_server::security::attest::HEADER,
                stamp
                    .parse::<reqwest::header::HeaderValue>()
                    .map_err(|e| e.to_string())?,
            );
        }
        Ok(())
    });
    let (program, args) = command("--conform");
    let reader = reader::Command { program, args };
    let (program, args) = command("--bot-test");
    let scenarios = runtime::Command { program, args };
    let doors = runtime::Doors {
        http: Some(&http),
        scenarios: Some(&scenarios),
        run: "spade",
    };
    let report = Report {
        spec: "1.0",
        levels: vec![
            reader::run(&reader).await,
            runtime::run(&doors).await,
            surfaces::run(&doors).await,
        ],
    };
    assert!(report.passed(), "{}", report.text());
    Ok(())
}
