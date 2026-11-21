//! `spade-conform`: the conformance suite's runner, as a command. See the crate's docs for the
//! doors; `--help` for the flags.

use std::ffi::OsString;
use std::process::ExitCode;

use spade_conform::http::Http;
use spade_conform::{Report, reader, runtime, surfaces};

const USAGE: &str = "\
usage: spade-conform [--reader <program> [--reader-arg <arg>]...]
                     [--runtime <url>] [--scenarios <program> [--scenarios-arg <arg>]...]
                     [--level reader|runtime|surfaces]... [--json]

Runs the Spade Agent Format's conformance suite against an implementation.
  --reader      a reader: `<program> <args> read <folder>` and `<program> <args> fit <file>`
                answer JSON (Spade: --reader spade --reader-arg --conform)
  --runtime     a runtime's HTTP API root; its token is read from SPADE_CONFORM_TOKEN
  --scenarios   a runtime's scenario door: `<program> <args> <folder>` answers the report
                `spade --bot-test` prints (Spade: --scenarios spade --scenarios-arg --bot-test)
  --level       the levels to run; every level a door was given for when unset
  --json        print the report as JSON
Exits 0 when every case of every level run passed, 1 when one failed, 2 on a usage mistake.";

#[derive(Default)]
struct Flags {
    reader: Option<(OsString, Vec<OsString>)>,
    runtime: Option<String>,
    scenarios: Option<(OsString, Vec<OsString>)>,
    levels: Vec<String>,
    json: bool,
}

fn flags(args: Vec<OsString>) -> Result<Flags, String> {
    let mut out = Flags::default();
    let mut args = args.into_iter();
    while let Some(flag) = args.next() {
        let flag = flag.to_string_lossy().into_owned();
        let mut value = || args.next().ok_or_else(|| format!("{flag} needs a value"));
        match flag.as_str() {
            "--reader" => out.reader = Some((value()?, Vec::new())),
            "--reader-arg" => match out.reader.as_mut() {
                Some((_, extra)) => extra.push(value()?),
                None => return Err("--reader-arg comes after --reader".to_owned()),
            },
            "--runtime" => out.runtime = Some(value()?.to_string_lossy().into_owned()),
            "--scenarios" => out.scenarios = Some((value()?, Vec::new())),
            "--scenarios-arg" => match out.scenarios.as_mut() {
                Some((_, extra)) => extra.push(value()?),
                None => return Err("--scenarios-arg comes after --scenarios".to_owned()),
            },
            "--level" => {
                let level = value()?.to_string_lossy().into_owned();
                if !["reader", "runtime", "surfaces"].contains(&level.as_str()) {
                    return Err(format!("{level} isn't a level"));
                }
                out.levels.push(level);
            }
            "--json" => out.json = true,
            other => return Err(format!("unknown argument {other}")),
        }
    }
    Ok(out)
}

fn main() -> ExitCode {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    let flags = match flags(args) {
        Ok(flags)
            if flags.reader.is_some() || flags.runtime.is_some() || flags.scenarios.is_some() =>
        {
            flags
        }
        Ok(_) => {
            eprintln!("spade-conform: give at least one door\n{USAGE}");
            return ExitCode::from(2);
        }
        Err(why) => {
            eprintln!("spade-conform: {why}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("spade-conform couldn't start: {error}");
            return ExitCode::FAILURE;
        }
    };
    let report = runtime.block_on(run(&flags));
    if flags.json {
        match serde_json::to_string_pretty(&report) {
            Ok(json) => println!("{json}"),
            Err(error) => eprintln!("the report couldn't be written: {error}"),
        }
    } else {
        print!("{}", report.text());
    }
    if report.passed() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

async fn run(flags: &Flags) -> Report {
    let wants = |level: &str, door: bool| {
        if flags.levels.is_empty() {
            door
        } else {
            flags.levels.iter().any(|l| l == level)
        }
    };
    let token = std::env::var("SPADE_CONFORM_TOKEN").unwrap_or_default();
    let http = flags.runtime.as_deref().map(|url| Http::new(url, &token));
    let scenarios = flags
        .scenarios
        .as_ref()
        .map(|(program, args)| runtime::Command {
            program: program.clone(),
            args: args.clone(),
        });
    // Unique to this run: a runtime that keeps install transactions never meets one twice.
    let run_id = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis())
    );
    let doors = runtime::Doors {
        http: http.as_ref(),
        scenarios: scenarios.as_ref(),
        run: &run_id,
    };
    let runtime_door = flags.runtime.is_some() || flags.scenarios.is_some();
    let mut levels = Vec::new();
    if wants("reader", flags.reader.is_some()) {
        match &flags.reader {
            Some((program, args)) => {
                let door = reader::Command {
                    program: program.clone(),
                    args: args.clone(),
                };
                levels.push(reader::run(&door).await);
            }
            None => levels.push(spade_conform::Level {
                level: "Reader",
                cases: Vec::new(),
            }),
        }
    }
    if wants("runtime", runtime_door) {
        levels.push(runtime::run(&doors).await);
    }
    if wants("surfaces", runtime_door) {
        levels.push(surfaces::run(&doors).await);
    }
    Report {
        spec: "1.0",
        levels,
    }
}
