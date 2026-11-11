//! Development check against a real endpoint. Spends quota, so it only runs by hand:
//!
//!     OPENCODE_API_KEY=… cargo run -p spade-models --example ask -- [endpoint/model] "question"
//!
//! Run from the repository root so `config/models.json` is found (or set `SPADE_MODEL_CATALOG`).
//! Without a model it uses the main role's model. The reply streams to stdout.

use std::io::Write;

use futures_util::StreamExt;
use spade_models::{Catalog, Delta, Keys, Models, ModelsConfig, Prompt, Role};

#[tokio::main]
async fn main() -> std::process::ExitCode {
    match run().await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            std::process::ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let question = args.pop().ok_or("usage: ask [model] \"question\"")?;
    let config = ModelsConfig::from_env(|key| std::env::var(key).ok());
    let catalog = Catalog::load(&config.catalog)?;
    let models = Models::new(catalog, Keys::from_process_env(), env!("CARGO_PKG_VERSION"))?;
    let model = args
        .pop()
        .unwrap_or_else(|| models.for_role(Role::Main).to_owned());
    eprintln!("{model}");

    let mut stream = Box::pin(
        models
            .stream(&model, &Prompt::ask(question).max_tokens(512))
            .await?,
    );
    let mut out = std::io::stdout();
    while let Some(delta) = stream.next().await {
        match delta? {
            Delta::Text(text) => write!(out, "{text}")?,
            Delta::Reasoning(_) | Delta::Call(_) => {}
            Delta::Done { usage, .. } => eprintln!(
                "\n[{} in, {} out]",
                usage.input_tokens.map_or("?".into(), |n| n.to_string()),
                usage.output_tokens.map_or("?".into(), |n| n.to_string()),
            ),
        }
        out.flush()?;
    }
    Ok(())
}
