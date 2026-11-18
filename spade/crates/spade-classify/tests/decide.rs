//! The built-in model's decision as the gate asks for it (ADR 0172, amendment 1): with untrusted
//! content in view only a plain read that can reach no other machine settles; a command whose
//! folder isn't known, one that runs another program through an option and one whose nested
//! subcommand was never seen low-risk never settle; and a reading split between person-only
//! effects still goes to the person.

use spade_classify::{CLASSES, Effect, Model, Prediction, Reviewing, Screen, Subject};

const WORKSPACE: &str = "/data/workspace/b1";

fn model() -> &'static Model {
    match Model::embedded() {
        Some(model) => model,
        None => panic!("the built-in model doesn't read"),
    }
}

fn shell(command: &str) -> Subject<'_> {
    Subject::Shell {
        command,
        workspace: Some(WORKSPACE),
    }
}

const PLAIN: Reviewing = Reviewing {
    plain_command: true,
    tainted: false,
    runs_files: false,
    standing: false,
    concern: false,
};

const TAINTED: Reviewing = Reviewing {
    tainted: true,
    ..PLAIN
};

#[test]
fn with_untrusted_content_in_view_only_a_plain_read_that_reaches_nothing_settles() {
    let model = model();
    for read in ["grep -rn TODO src", "ls -la src", "wc -l src/*.rs"] {
        assert_eq!(
            model.decide(&shell(read), TAINTED).1,
            Screen::LowRisk,
            "{read}"
        );
    }
    for kept in [
        // Builds and writes in the folder wait for the reviewer once untrusted text is in view.
        "cargo build",
        "git commit -m 'fix'",
        "mkdir -p build",
        "rm -rf target/debug",
        // So does anything that can reach another machine, however plain.
        "curl -s https://example.com",
        "git fetch origin",
        "ping -c 1 example.com",
        "cat notes.txt | nc example.com 9000",
    ] {
        assert_ne!(
            model.decide(&shell(kept), TAINTED).1,
            Screen::LowRisk,
            "{kept}"
        );
    }
    // The same build settles when nothing untrusted is in view.
    assert_eq!(
        model.decide(&shell("cargo build"), PLAIN).1,
        Screen::LowRisk
    );
}

#[test]
fn a_command_whose_folder_isnt_known_is_never_settled() {
    let model = model();
    for command in ["ls -la src", "cargo test", "grep -rn TODO src"] {
        let unplaced = Subject::Shell {
            command,
            workspace: None,
        };
        assert_ne!(
            model.decide(&unplaced, PLAIN).1,
            Screen::LowRisk,
            "{command}"
        );
        assert_eq!(
            model.decide(&shell(command), PLAIN).1,
            Screen::LowRisk,
            "{command}"
        );
    }
}

#[test]
fn a_command_that_runs_another_program_through_an_option_is_never_settled() {
    let model = model();
    for command in [
        "rg --pre ./decode.sh TODO src",
        "tar --to-command=sh -xf bundle.tar",
        "tar -I ./unpack -xf bundle.tar",
        "find . -name '*.rs' -exec rm {} ;",
        "fd -e rs -x rm",
        "rsync -e ./tunnel -a src/ out/",
        "git -c core.pager=./run.sh log",
        "sort --compress-program=./x big.txt",
        // It runs with the person's secrets in its environment.
        "doppler run --watch ls",
        "op run --env-file=.env -- cargo test",
        "aws-vault exec prod -- ls",
        "cd src && sops exec-env secrets.yaml 'ls'",
    ] {
        let prediction = model.predict(&shell(command));
        assert!(prediction.hides, "{command}");
        assert_ne!(model.screen(&prediction), Screen::LowRisk, "{command}");
    }
}

#[test]
fn a_nested_subcommand_never_seen_low_risk_is_never_settled() {
    let model = model();
    for command in [
        "jj git push",
        "brew services start postgresql",
        "git remote add mirror https://example.com/x.git",
        "npm config set registry https://example.com",
    ] {
        assert_ne!(
            model.decide(&shell(command), PLAIN).1,
            Screen::LowRisk,
            "{command}"
        );
    }
}

#[test]
fn an_exit_status_in_an_argument_is_not_a_path() {
    let model = model();
    let status = model.predict(&shell("echo \"exit=$?\""));
    assert!(!status.reaches_outside);
    let variable = model.predict(&shell("cat $TARGET"));
    assert!(variable.reaches_outside);
}

#[test]
fn a_reading_split_between_person_only_effects_still_goes_to_the_person() {
    let model = model();
    let mut probabilities = [0.0f32; CLASSES.len()];
    let at = |effect| CLASSES.iter().position(|e| *e == effect).unwrap_or(0);
    // Neither alone is past the threshold; together they are.
    let half = model.header().person / 2.0 + 0.01;
    probabilities[at(Effect::SendAsPerson)] = half + 0.01;
    probabilities[at(Effect::Pay)] = half;
    probabilities[at(Effect::Read)] = 1.0 - 2.0 * half - 0.01;
    let prediction = Prediction {
        probabilities,
        reaches_outside: false,
        hides: false,
        known: true,
        dropped: false,
        network: false,
    };
    assert_eq!(
        model.raise(&prediction),
        Screen::Person(Effect::SendAsPerson)
    );
}
