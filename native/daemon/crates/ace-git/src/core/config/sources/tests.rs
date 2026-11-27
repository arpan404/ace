use super::*;
fn layout() -> Layout {
    Layout {
        git_dir: "/wt/.git".to_owned(),
        common_dir: "/wt/.git".to_owned(),
        toplevel: "/wt".to_owned(),
    }
}

#[test]
fn a_bare_repository_planted_between_a_subdirectory_and_its_root_is_watched() {
    let watched = watched_paths("/wt/a/b", &layout(), &[], &[]).expect("watched");
    for directory in ["/wt/a/b", "/wt/a"] {
        for part in [".git", "HEAD", "objects", "refs", "config"] {
            let path = format!("{directory}/{part}");
            assert!(watched.contains(&path), "{path} missing");
        }
    }
    // The checkout root is found through its own .git; its HEAD is the worktree's.
    assert!(!watched.contains(&"/wt/objects".to_owned()));
}

#[test]
fn a_directory_outside_its_checkout_root_cannot_be_stamped() {
    assert_eq!(watched_paths("/elsewhere", &layout(), &[], &[]), None);
}

#[test]
fn a_listing_keeps_its_files_and_include_targets_in_order() {
    let listing = "global\0file:/home/u/.gitconfig\0user.name\nu\0\
local\0file:.git/config\0branch.x.merge\nmain\0\
local\0file:.git/config\0include.path\n../shared.inc\0\
local\0file:.git/config\0includeif.onbranch:main.path\n~/team.inc\0";
    let listed = listed_sources(listing, &layout(), Some("/home/u")).expect("listed");
    assert_eq!(
        listed,
        vec![
            "/home/u/.gitconfig".to_owned(),
            "/wt/.git/config".to_owned(),
            "/wt/shared.inc".to_owned(),
            "/home/u/team.inc".to_owned(),
        ]
    );
}

#[test]
fn an_unplaceable_origin_or_include_refuses_the_whole_listing() {
    let cases = [
        // Not a file origin.
        "local\0https://example.invalid/x\0user.name\nu\0",
        // A relative name that is not one of the repository's own files.
        "local\0file:other\0user.name\nu\0",
        // `~user` and `%(prefix)` depend on the account database and Git's build.
        "local\0file:.git/config\0include.path\n~user/x\0",
        "local\0file:.git/config\0include.path\n%(prefix)/x\0",
        // A listing without its final terminator, or with a partial record.
        "local\0file:.git/config\0user.name\nu",
        "local\0file:.git/config\0",
    ];
    for listing in cases {
        assert_eq!(
            listed_sources(listing, &layout(), Some("/home/u")),
            None,
            "{listing}"
        );
    }
    // A `~/` target needs a home directory to name.
    assert_eq!(
        listed_sources(
            "local\0file:.git/config\0include.path\n~/x\0",
            &layout(),
            None
        ),
        None
    );
}

#[test]
fn command_scope_entries_are_ours_and_never_files() {
    let listed = listed_sources(
        "command\0\0core.hooksPath\n/dev/null\0local\0file:.git/config\0user.name\nu\0",
        &layout(),
        None,
    )
    .expect("listed");
    assert_eq!(listed, vec!["/wt/.git/config".to_owned()]);
}

#[test]
fn a_huge_listing_yields_only_its_file_names() {
    // The TypeScript case measures that a kept path does not pin the whole listing
    // (a JS slice of a 512 KB string). Rust copies the two names and keeps nothing of the
    // input, so the same listing parse is asserted once and the retention is structural.
    let filler = format!("branch.x.merge\n{}", "r".repeat(512 * 1024));
    let listing = format!(
        "global\0file:/home/u/.gitconfig\0user.name\nu\0local\0file:.git/config\0{filler}\0"
    );
    for _ in 0..80 {
        assert_eq!(
            listed_sources(&listing, &layout(), Some("/home/u")).expect("listed"),
            vec![
                "/home/u/.gitconfig".to_owned(),
                "/wt/.git/config".to_owned()
            ]
        );
    }
}

#[test]
fn config_environment_drops_neutral_names_and_sorts_the_rest() {
    let env = vec![
        ("GIT_INDEX_FILE".to_owned(), "/tmp/i".to_owned()),
        ("GIT_DIR".to_owned(), "/wt/.git".to_owned()),
        ("HOME".to_owned(), "/home/u".to_owned()),
        ("GIT_OPTIONAL_LOCKS".to_owned(), "0".to_owned()),
    ];
    assert_eq!(
        config_environment(&env),
        vec![
            ("GIT_DIR".to_owned(), "/wt/.git".to_owned()),
            ("HOME".to_owned(), "/home/u".to_owned()),
        ]
    );
}

#[test]
fn a_single_value_strips_one_terminator_and_crlf_only_on_windows() {
    assert_eq!(single("/wt\n", false), "/wt");
    assert_eq!(single("/wt\n\n", false), "/wt\n");
    assert_eq!(single("C:\\wt\r\n", true), "C:\\wt");
    assert_eq!(single("C:\\wt\r\n", false), "C:\\wt\r");
}
