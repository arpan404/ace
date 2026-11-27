use super::*;
use crate::core::credentials::test_support::{Fixture, ProcessQuery, quote_config};

#[tokio::test]
async fn a_transfer_reads_only_helpers_outside_the_checkout_and_keeps_url_scope_and_order() {
    let fixture = Fixture::new("helpers");
    let repo = fixture.repository("repo with spaces\nand \u{96ea}");
    let home = fixture.root.clone();
    let inside = repo.join("planted.gitconfig");
    std::fs::write(
        &inside,
        "[credential]\n\thelper = planted\n\thelper = planted-too\n",
    )
    .expect("planted");
    let user = home.join("user.gitconfig");
    std::fs::write(
            &user,
            format!(
                "[credential]\n\thelper = generic\n[credential \"http://127.0.0.1:8080/repo.git\"]\n\thelper = scoped\n[include]\n\tpath = {}\n",
                quote_config(&inside)
            ),
        )
        .expect("user config");
    // The repository's own helper is never a file the transfer reads.
    fixture.git(&repo, &["config", "credential.helper", "repo-helper"]);

    let query = ProcessQuery {
        fixture: &fixture,
        cwd: &repo,
        env: &[],
    };
    let trusted = TrustedOrigin::new(&[repo.to_string_lossy().into_owned()]);
    let helpers = read_credential_helpers(&query, &user.to_string_lossy(), &trusted)
        .await
        .expect("helpers");
    assert_eq!(
        helpers,
        vec![
            CredentialHelper {
                key: "credential.helper".to_owned(),
                value: "generic".to_owned(),
            },
            CredentialHelper {
                key: "credential.http://127.0.0.1:8080/repo.git.helper".to_owned(),
                value: "scoped".to_owned(),
            },
        ]
    );
    // The planted file is inside the checkout, so its entries are dropped even through the
    // person's own include.
    assert!(!trusted.trusted(Some(&format!("file:{}", inside.display()))));
    assert!(trusted.trusted(Some(&format!("file:{}", user.display()))));
}

#[tokio::test]
async fn an_ssh_command_follows_includes_under_the_same_trust_rule() {
    let fixture = Fixture::new("ssh");
    let repo = fixture.repository("repo");
    let outside = fixture.root.join("outside.gitconfig");
    std::fs::write(&outside, "[core]\n\tsshCommand = person-ssh\n").expect("outside");
    let person = fixture.root.join("person.gitconfig");
    std::fs::write(
        &person,
        format!(
            "[include]\n\tpath = {}\n[core]\n\tsshCommand = later-ssh\n",
            quote_config(&outside)
        ),
    )
    .expect("person");
    // The repository's own value counts only for a checkout no agent writes.
    fixture.git(&repo, &["config", "core.sshCommand", "repo-ssh"]);
    let query = ProcessQuery {
        fixture: &fixture,
        cwd: &repo,
        env: &[],
    };
    let trusted = TrustedOrigin::new(&[repo.to_string_lossy().into_owned()]);
    assert_eq!(
        read_ssh_commands(&query, &person.to_string_lossy(), &trusted)
            .await
            .expect("commands"),
        vec!["person-ssh".to_owned(), "later-ssh".to_owned()]
    );
    assert_eq!(
        repository_ssh_commands(&query)
            .await
            .expect("repo commands"),
        vec!["repo-ssh".to_owned()]
    );
}
