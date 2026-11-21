//! `spade --conform read <folder>` and `spade --conform fit <file>` (ADR 0201 §5): Spade behind
//! `spade-conform`'s reader door. Reads the package folder or the schema question and prints
//! [`spade_core::spec::door`]'s answer as JSON. Never opens the data folder, a database or a
//! socket.

use std::path::Path;

use serde_json::Value;

const USAGE: &str = "usage: spade --conform read <package folder> | fit <file>";

pub fn main(args: &[std::ffi::OsString]) -> std::process::ExitCode {
    let (Some(verb), Some(path)) = (args.first().and_then(|a| a.to_str()), args.get(1)) else {
        eprintln!("{USAGE}");
        return std::process::ExitCode::from(2);
    };
    let path = Path::new(path);
    let answer = match verb {
        "read" => read(path),
        "fit" => match std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        {
            Some(asked) => spade_core::spec::door::fit(&asked),
            None => {
                eprintln!("{}: isn't a JSON file", path.display());
                return std::process::ExitCode::from(2);
            }
        },
        _ => {
            eprintln!("{USAGE}");
            return std::process::ExitCode::from(2);
        }
    };
    println!("{answer}");
    std::process::ExitCode::SUCCESS
}

fn read(folder: &Path) -> Value {
    let bot = std::fs::read_to_string(folder.join("bot.json")).unwrap_or_default();
    let file = |path: &str| std::fs::read_to_string(folder.join(path)).ok();
    spade_core::spec::door::read(&bot, file, crate::packages::build())
}
