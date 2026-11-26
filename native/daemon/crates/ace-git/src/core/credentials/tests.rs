use super::test_support::{Fixture, ProcessQuery, SequenceQuery};
use super::*;

fn output(text: &str) -> ConfigOutput {
    ConfigOutput {
        stdout: text.as_bytes().to_vec(),
        exit_code: 0,
        truncated: false,
    }
}

#[test]
fn values_refuse_truncation_bad_exits_and_unterminated_listings() {
    assert_eq!(
        records(&output("a\0b\0"), 2).ok(),
        Some(vec![vec!["a".to_owned(), "b".to_owned()]])
    );
    // An empty listing is no fields, not one empty field.
    assert_eq!(values(&output("")).ok(), Some(Vec::new()));
    assert_eq!(values(&output("\0")).ok(), Some(vec![String::new()]));
    let truncated = ConfigOutput {
        truncated: true,
        ..output("a\0")
    };
    assert_eq!(
        values(&truncated).err().map(|error| error.code),
        Some(GitErrorCode::OutputTooLarge)
    );
    for exit_code in [2, 128] {
        let failed = ConfigOutput {
            exit_code,
            ..output("a\0")
        };
        assert_eq!(
            values(&failed).err().map(|error| error.code),
            Some(GitErrorCode::GitFailed)
        );
    }
    // Git reports "no such key" with 1: a partial listing is malformed, not empty.
    let partial = ConfigOutput {
        exit_code: 1,
        ..output("a\0")
    };
    assert_eq!(
        values(&partial).err().map(|error| error.code),
        Some(GitErrorCode::MalformedOutput)
    );
    assert!(values(&output("a")).is_err());
    assert!(records(&output("a\0b\0c\0"), 2).is_err());
    let invalid = ConfigOutput {
        stdout: vec![0xff, 0xfe],
        exit_code: 0,
        truncated: false,
    };
    assert_eq!(
        values(&invalid).err().map(|error| error.code),
        Some(GitErrorCode::MalformedOutput)
    );
}

#[test]
fn helper_keys_and_values_are_bounded_in_code_points_and_refuse_an_equals_sign() {
    // A zod bound counts code points: 4,096 code points is 8,174 UTF-16 units here.
    let longest = format!(
        "credential.{}.helper",
        "\u{1F600}".repeat(4_096 - "credential.".len() - ".helper".len())
    );
    assert_eq!(longest.chars().count(), 4_096);
    assert!(
        validate_helpers(vec![CredentialHelper {
            key: longest.clone(),
            value: "\u{1F600}".repeat(16_384),
        }])
        .is_ok()
    );
    let too_long = format!("{longest}\u{1F600}");
    assert!(
        validate_helpers(vec![CredentialHelper {
            key: too_long,
            value: String::new(),
        }])
        .is_err()
    );
    assert!(
        validate_helpers(vec![CredentialHelper {
            key: "credential.helper".to_owned(),
            value: "\u{1F600}".repeat(16_385),
        }])
        .is_err()
    );
    for key in [
        "credential..helper",
        "credential.a=b.helper",
        "credentialx.helper",
        "credential.a\n.helper",
        "credential.helper\n",
    ] {
        assert!(
            validate_helpers(vec![CredentialHelper {
                key: key.to_owned(),
                value: "x".to_owned(),
            }])
            .is_err(),
            "{key}"
        );
    }
    // A URL-scoped helper is a helper; the URL may carry `:` and `/`.
    for key in [
        "credential.http://127.0.0.1:8080/repo.git.helper",
        "credential.helper",
    ] {
        assert!(
            validate_helpers(vec![CredentialHelper {
                key: key.to_owned(),
                value: "!run".to_owned(),
            }])
            .is_ok(),
            "{key}"
        );
    }
    assert!(
        validate_helpers(vec![
            CredentialHelper {
                key: "credential.helper".to_owned(),
                value: "x".to_owned(),
            };
            513
        ])
        .is_err()
    );
    assert!(
        validate_helpers(vec![CredentialHelper {
            key: "credential.helper".to_owned(),
            value: "a\0b".to_owned(),
        }])
        .is_err()
    );
}

#[test]
fn helper_args_reset_every_inherited_helper_before_restoring_trust() {
    assert_eq!(
        credential_helper_args(vec![CredentialHelper {
            key: "credential.https://example.invalid/.helper".to_owned(),
            value: "!run".to_owned(),
        }])
        .expect("args"),
        vec![
            "-c",
            "credential.helper=",
            "-c",
            "core.askPass=",
            "-c",
            "credential.https://example.invalid/.helper=!run",
        ]
    );
    // The schema is applied here too: a helper the caller built by hand cannot widen trust.
    assert!(
        credential_helper_args(vec![CredentialHelper {
            key: "credential.a=b.helper".to_owned(),
            value: "x".to_owned(),
        }])
        .is_err()
    );
}

#[tokio::test]
async fn the_system_file_is_the_one_git_compiled_unless_it_sets_nothing_a_transfer_borrows() {
    let fixture = Fixture::new("system");
    let repo = fixture.repository("repo");
    let system = fixture.root.join("system.gitconfig");
    std::fs::write(&system, "[credential]\n\thelper = system-helper\n").expect("system");
    let path = system.to_string_lossy().into_owned();
    let query = ProcessQuery {
        fixture: &fixture,
        cwd: &repo,
        env: &[("GIT_CONFIG_SYSTEM", &path)],
    };
    assert_eq!(
        system_credential_config_file(&query)
            .await
            .expect("system file"),
        Some(path.clone())
    );
    std::fs::write(&system, "[core]\n\teditor = true\n").expect("unrelated system");
    assert_eq!(
        system_credential_config_file(&query).await.expect("none"),
        None
    );
}

#[tokio::test]
async fn a_system_origin_that_is_not_one_absolute_file_is_malformed_output() {
    for (stdout, code) in [
        (
            "command:\0credential.helper\0",
            GitErrorCode::MalformedOutput,
        ),
        ("file:\0credential.helper\0", GitErrorCode::MalformedOutput),
        (
            "file:relative\0credential.helper\0",
            GitErrorCode::MalformedOutput,
        ),
        (
            "file:/a\0not-a-borrowed-key\0",
            GitErrorCode::MalformedOutput,
        ),
        (
            "file:/a\0credential.helper\0file:/b\0core.sshcommand\0",
            GitErrorCode::MalformedOutput,
        ),
        (
            "file:/a\0credential.a=b.helper\0",
            GitErrorCode::MalformedOutput,
        ),
    ] {
        let answers = SequenceQuery::new(vec![output(stdout)]);
        let error = system_credential_config_file(&answers)
            .await
            .expect_err(stdout);
        assert_eq!(error.code, code, "{stdout}");
    }
    let answers = SequenceQuery::new(vec![output(
        "file:/a\0credential.helper\0file:/a\0core.sshcommand\0",
    )]);
    assert_eq!(
        system_credential_config_file(&answers)
            .await
            .expect("same file"),
        Some("/a".to_owned())
    );
}

#[test]
fn an_unresolvable_root_is_skipped_rather_than_blocking_every_origin() {
    // Node's realpath failure leaves the root undefined, which never matches, so a
    // checkout that vanished cannot block the person's own files.
    let trusted = TrustedOrigin::new(&["/nonexistent/ace-g2c/root".to_owned()]);
    assert!(!trusted.trusted(None));
    assert!(!trusted.trusted(Some("file:relative")));
    assert!(!trusted.trusted(Some("command:/a")));
    assert!(!trusted.trusted(Some("file:/nonexistent/file")));
    let file = std::env::temp_dir().join(format!("ace-git-g2c-trust-{}", std::process::id()));
    std::fs::write(&file, "").expect("file");
    assert!(trusted.trusted(Some(&format!("file:{}", file.display()))));
    std::fs::remove_file(&file).ok();
}
