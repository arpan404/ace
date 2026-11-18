//! The built-in model's decision as the gate asks for it (ADR 0172, amendment 1): with untrusted
//! content in view only a plain read that can reach no other machine settles; a command whose
//! folder isn't known, one that runs another program through an option and one whose nested
//! subcommand was never seen low-risk never settle; and a reading split between person-only
//! effects still goes to the person.

use spade_classify::{CLASSES, ConfigTools, Effect, Model, Prediction, Reviewing, Screen, Subject};

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
            model.decide(&shell(read), TAINTED, ConfigTools::ALL).screen,
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
            model.decide(&shell(kept), TAINTED, ConfigTools::ALL).screen,
            Screen::LowRisk,
            "{kept}"
        );
    }
    // A read settles when nothing untrusted is in view; a write never settles, however plain
    // (ADR 0172, amendment 4).
    assert_eq!(
        model
            .decide(&shell("git log --oneline -5"), PLAIN, ConfigTools::ALL)
            .screen,
        Screen::LowRisk
    );
    assert_ne!(
        model
            .decide(&shell("cp README.md docs/"), PLAIN, ConfigTools::ALL)
            .screen,
        Screen::LowRisk
    );
}

#[test]
fn a_command_whose_folder_isnt_known_is_never_settled() {
    let model = model();
    for command in ["ls -la src", "wc -l src/main.rs", "grep -rn TODO src"] {
        let unplaced = Subject::Shell {
            command,
            workspace: None,
        };
        assert_ne!(
            model.decide(&unplaced, PLAIN, ConfigTools::ALL).screen,
            Screen::LowRisk,
            "{command}"
        );
        assert_eq!(
            model
                .decide(&shell(command), PLAIN, ConfigTools::ALL)
                .screen,
            Screen::LowRisk,
            "{command}"
        );
    }
}

#[test]
fn a_command_that_runs_another_program_or_carries_a_credential_is_never_settled() {
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
        // It carries a credential.
        "git clone https://sam:ghp_abcdefghijklmnop0123456789@github.com/acme/app.git",
        "curl -H 'Authorization: Bearer sk_live_abcdefghijklmnop0123' https://api.example.com",
        "echo glpat-abcdefghijklmnopqrst > token.txt",
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
            model
                .decide(&shell(command), PLAIN, ConfigTools::ALL)
                .screen,
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
        config: ConfigTools::default(),
        hardened: true,
    };
    assert_eq!(
        model.raise(&prediction),
        Screen::Person(Effect::SendAsPerson)
    );
}

#[test]
fn a_tool_whose_configuration_could_run_a_program_settles_only_where_it_was_found_to_run_none() {
    let model = model();
    for (command, only) in [
        (
            "git status --short",
            ConfigTools {
                git: true,
                ..ConfigTools::default()
            },
        ),
        (
            "git log --oneline -5",
            ConfigTools {
                git: true,
                ..ConfigTools::default()
            },
        ),
        (
            "cargo build",
            ConfigTools {
                cargo: true,
                ..ConfigTools::default()
            },
        ),
        (
            "npm install",
            ConfigTools {
                node: true,
                ..ConfigTools::default()
            },
        ),
    ] {
        let all_but = ConfigTools {
            git: !only.git,
            node: !only.node,
            cargo: !only.cargo,
            ripgrep: true,
        };
        assert_ne!(
            model.decide(&shell(command), PLAIN, all_but).screen,
            Screen::LowRisk,
            "{command}"
        );
        assert_ne!(
            model
                .decide(&shell(command), PLAIN, ConfigTools::default())
                .screen,
            Screen::LowRisk,
            "{command}"
        );
    }
    // A tool that reads no such configuration needs no inspection.
    assert_eq!(
        model
            .decide(&shell("ls -la src"), PLAIN, ConfigTools::default())
            .screen,
        Screen::LowRisk
    );
    // `rg --no-config` reads none either; plain `rg` needs ripgrep's.
    let no_ripgrep = ConfigTools {
        ripgrep: false,
        ..ConfigTools::ALL
    };
    assert_ne!(
        model
            .decide(&shell("rg -n TODO src"), PLAIN, no_ripgrep)
            .screen,
        Screen::LowRisk
    );
    assert!(
        !model
            .predict(&shell("rg --no-config -n TODO src"))
            .config
            .ripgrep
    );
    assert!(model.predict(&shell("rg -n TODO src")).config.ripgrep);
}

#[test]
fn a_configurable_tool_run_elsewhere_or_pointed_at_other_configuration_is_never_settled() {
    let model = model();
    for command in [
        "cd vendor/lib && git status",
        "git -C ../other status",
        "git --git-dir=other/.git log",
        "cargo --config 'target.x.runner=\"./r\"' test",
        "npm --node-options=--require=./x.js ls",
        "PATH=./bin:$PATH ls",
        "PYTHONPATH=. python3 -m pytest",
        "GIT_PAGER=./p git log",
        "export RIPGREP_CONFIG_PATH=./rg.conf; rg TODO",
        "direnv exec . ls",
        "mise exec -- cargo build",
    ] {
        let prediction = model.predict(&shell(command));
        assert!(prediction.hides, "{command}");
        assert_ne!(
            model
                .decide(&shell(command), PLAIN, ConfigTools::ALL)
                .screen,
            Screen::LowRisk,
            "{command}"
        );
    }
    // Moving to the bot's own folder first changes nothing.
    let home = format!("cd {WORKSPACE} && git status");
    assert!(!model.predict(&shell(&home)).hides);
}

#[test]
fn a_command_settles_only_with_the_form_it_runs_in() {
    let model = model();
    let settled = model.decide(&shell("git ls-files"), PLAIN, ConfigTools::ALL);
    assert_eq!(settled.screen, Screen::LowRisk);
    let form = settled
        .hardening
        .unwrap_or_else(|| panic!("settled without a form"));
    assert!(
        form.env
            .iter()
            .any(|(n, v)| n == "GIT_CONFIG_GLOBAL" && v == "/dev/null")
    );
    assert_eq!(Some(form), spade_classify::hardening("git ls-files"));
    // Commands no override covers never settle, however plain: git's that run diff or filter
    // drivers, the package managers and cargo, writes, and script languages (amendment 4).
    for command in [
        "git status --short",
        "git diff",
        "cargo build",
        "npm ci",
        "git log -p -1",
        "cp a.txt b.txt",
        "touch new.rs",
        "echo hi > out.txt",
        "awk '{print}' x",
        "sed -n '1,5p' x",
    ] {
        let decision = model.decide(&shell(command), PLAIN, ConfigTools::ALL);
        assert_ne!(decision.screen, Screen::LowRisk, "{command}");
        assert!(decision.hardening.is_none(), "{command}");
    }
    // Raising or abstaining never comes with a form.
    let raised = model.decide(&shell("cat ~/.ssh/id_rsa"), PLAIN, ConfigTools::ALL);
    assert!(raised.hardening.is_none());
}
