//! Organizations in the gate, on the access list and in the audit chain (ADR 0206).

use super::audit::{self, Chained, Checkpoint, Entry, GENESIS, Line, Ref};
use super::policy::{ModelPlace, Package, Source};
use super::*;
use crate::autonomy::{Class, Mode};
use crate::effect::ceiling::Ceiling;
use crate::effect::{self, Call, Drive, Effect, Granted, Place, Route};
use crate::gate::Decision;
use crate::tools::Risk;

fn call(effect: Option<Effect>, place: Place) -> Call<'static> {
    Call {
        tool: "crm__update",
        rule: Decision::Ask,
        risk: Risk::Write,
        always: false,
        effect,
        remembered: None,
        place,
        tainted: false,
        credentials: false,
        standing: false,
        fits: true,
        granted: Granted::No,
        checkpointed: false,
        target: None,
        drive: Drive::default(),
        mode: Mode::AutoReview,
        remote: false,
        classifier: true,
        ceiling: None,
        command: None,
        destructive: false,
        org: None,
    }
}

fn policy(body: &str) -> &'static Policy {
    Box::leak(Box::new(
        Policy::parse(body).unwrap_or_else(|| panic!("a policy")),
    ))
}

fn acme(body: &str) -> Option<Gate<'static>> {
    Some(Gate {
        org: "Acme",
        policy: policy(body),
    })
}

fn member(account: &str, role: &str) -> Member {
    Member {
        account: account.to_owned(),
        role: role.to_owned(),
        name: None,
    }
}

#[test]
fn the_organization_refuses_what_its_policy_turns_off_before_the_package_ceiling_in_every_mode() {
    let off = r#"{"effects": {"pay": "off", "publish": "off", "network_without_hosts": "off"}}"#;
    let refused = |why: &str| Route::Refuse(why.to_owned());
    for mode in [Mode::AutoReview, Mode::FullAccess] {
        // The package declares paying and the person left it on: the organization still says no.
        let paying = Call {
            mode,
            ceiling: Some(Ceiling {
                bot: "Buyer",
                allows: [Effect::Pay].into_iter().collect(),
            }),
            org: acme(off),
            always: true,
            rule: Decision::Run,
            ..call(Some(Effect::Pay), Place::Host)
        };
        assert_eq!(effect::route(paying), refused("Acme doesn't allow paying."));
        // Its refusal comes before the package's own: a package that declares nothing.
        let publishing = Call {
            mode,
            ceiling: Some(Ceiling {
                bot: "Buyer",
                allows: Default::default(),
            }),
            org: acme(off),
            ..call(Some(Effect::Publish), Place::Host)
        };
        assert_eq!(
            effect::route(publishing),
            refused("Acme doesn't allow publishing.")
        );
        // A command outside the sandbox is held to what it runs.
        let pushing = Call {
            mode,
            command: Some(Class::Outward),
            org: acme(off),
            ..call(Some(Effect::WriteLocal), Place::Unsandboxed(Class::Outward))
        };
        assert_eq!(
            effect::route(pushing),
            refused("Acme doesn't allow reaching outside without listed hosts.")
        );
    }
    // The sandbox holds network to the hosts the bot was given: not "without hosts".
    let sandboxed = Call {
        org: acme(off),
        ..call(Some(Effect::Network), Place::Sandbox)
    };
    assert_eq!(effect::route(sandboxed), Route::Run);
    // What the policy doesn't rule is decided as the host would.
    let allowed = Call {
        org: acme(off),
        ..call(Some(Effect::Read), Place::Host)
    };
    assert_eq!(effect::route(allowed), Route::Run);
}

#[test]
fn a_shared_bots_outward_step_runs_only_on_a_members_say() {
    let open = "{}";
    let to_approvers = Route::Ask {
        line: gate::APPROVERS.to_owned(),
        ask: None,
    };
    // Reviewed for a personal bot: an approver decides for a shared one.
    let reviewed = call(Some(Effect::Network), Place::Host);
    assert!(matches!(effect::route(reviewed), Route::Review(_)));
    let shared = Call {
        org: acme(open),
        ..reviewed
    };
    assert_eq!(effect::route(shared), to_approvers);
    // An approver's Always allow, or a member's grant, is a member's say.
    let always = Call {
        always: true,
        rule: Decision::Run,
        ..shared
    };
    assert_eq!(effect::route(always), Route::Run);
    let granted = Call {
        granted: Granted::Tool,
        ..shared
    };
    assert_eq!(effect::route(granted), Route::Run);
    // Full access lets nothing outward run on its own, with or without the policy's leave.
    for body in [open, r#"{"full_access": "admins"}"#] {
        let full = Call {
            mode: Mode::FullAccess,
            org: acme(body),
            ..call(Some(Effect::Network), Place::Host)
        };
        assert_eq!(effect::route(full), to_approvers, "{body}");
    }
    // A send in a person's name stays a request, now its approvers'.
    let send = Call {
        org: acme(open),
        ..call(Some(Effect::SendAsPerson), Place::Host)
    };
    assert!(matches!(effect::route(send), Route::Ask { .. }));
    // Reads and the bot's own writes are untouched.
    for local in [Effect::Read, Effect::WriteLocal] {
        let own = Call {
            org: acme(open),
            checkpointed: true,
            ..call(Some(local), Place::Host)
        };
        assert_eq!(effect::route(own), Route::Run);
    }
}

#[test]
fn commands_outside_the_sandbox_are_refused_where_the_policy_never_allows_them() {
    let never = r#"{"commands_outside_sandbox": "never"}"#;
    for place in [Place::AsksOutside, Place::Unsandboxed(Class::Inside)] {
        let outside = Call {
            org: acme(never),
            ..call(Some(Effect::WriteLocal), place)
        };
        assert_eq!(
            effect::route(outside),
            Route::Refuse("Acme doesn't allow commands outside the sandbox.".to_owned())
        );
    }
    let policy = policy(never);
    assert!(!policy.may_let_outside(Role::Owner, true));
    let admins = Policy::parse(r#"{"commands_outside_sandbox": "admins"}"#)
        .unwrap_or_else(|| panic!("policy"));
    assert!(admins.may_let_outside(Role::Admin, true));
    assert!(!admins.may_let_outside(Role::Member, true));
    assert!(!admins.may_let_outside(Role::Admin, false));
}

#[test]
fn members_never_turn_on_paying_sending_or_publishing_and_the_policy_narrows_admins() {
    let open = Policy::parse("{}").unwrap_or_else(|| panic!("policy"));
    for effect in [Effect::Pay, Effect::SendAsPerson, Effect::Publish] {
        assert_eq!(
            open.switch_refusal(effect, Role::Member, true),
            Some(policy::ADMINS_ONLY),
            "{effect:?}"
        );
        assert_eq!(open.switch_refusal(effect, Role::Admin, true), None);
    }
    // A member who configures the bot may turn on reaching out, unless the policy keeps it.
    assert_eq!(
        open.switch_refusal(Effect::Network, Role::Member, true),
        None
    );
    let kept = Policy::parse(r#"{"effects": {"network_without_hosts": "admins", "pay": "off"}}"#)
        .unwrap_or_else(|| panic!("policy"));
    assert_eq!(
        kept.switch_refusal(Effect::Network, Role::Member, true),
        Some(policy::ADMINS_ONLY)
    );
    // Off is off, for owners too.
    assert_eq!(
        kept.switch_refusal(Effect::Pay, Role::Owner, true),
        Some(policy::ORG_OFF)
    );
    // Nobody who doesn't configure the bot changes its switches.
    assert!(
        open.switch_refusal(Effect::Network, Role::Owner, false)
            .is_some()
    );
    // Full access is off unless the policy allows it.
    assert!(!open.may_raise_full_access(Role::Owner, true));
    let raise = Policy::parse(r#"{"full_access": "admins"}"#).unwrap_or_else(|| panic!("policy"));
    assert!(raise.may_raise_full_access(Role::Admin, true));
    assert!(!raise.may_raise_full_access(Role::Member, true));
}

#[test]
fn a_word_the_policy_uses_that_this_build_doesnt_know_reads_as_the_narrowest_rule() {
    let unknown = Policy::parse(
        r#"{"effects": {"pay": "sometimes"}, "full_access": "weekends",
            "packages": {"mode": "curated"}, "members_create_bots": "yes"}"#,
    )
    .unwrap_or_else(|| panic!("policy"));
    assert!(unknown.forbids(Effect::Pay));
    assert!(!unknown.full_access_allowed());
    assert!(!unknown.members_create_bots());
    let anything = Package {
        source: Source::Market,
        name: "spade-bot/anything",
        version: "1.0.0",
        hash: "sha256:00",
    };
    assert!(unknown.package_refusal(anything).is_some());
    // A body that isn't a policy is never one.
    for body in ["", "[]", "not json", "7"] {
        assert!(Policy::parse(body).is_none(), "{body}");
    }
}

#[test]
fn packages_follow_the_organizations_sources_list_and_blocks() {
    let body = r#"{"packages": {
        "sources": {"market": true, "registry": true},
        "mode": "allowlist",
        "allow": [{"source": "market", "name": "spade-bot/ci-watcher", "versions": ["1.2.0"]},
                  {"source": "registry", "name": "*"}],
        "block": [{"hash": "sha256:bad"}, {"name": "spade-bot/leaky"}]}}"#;
    let policy = Policy::parse(body).unwrap_or_else(|| panic!("policy"));
    let package = |source, name, version, hash| Package {
        source,
        name,
        version,
        hash,
    };
    let cases = [
        (
            package(Source::Market, "spade-bot/ci-watcher", "1.2.0", "sha256:ok"),
            true,
        ),
        (
            package(Source::Market, "spade-bot/ci-watcher", "1.3.0", "sha256:ok"),
            false,
        ),
        (
            package(Source::Market, "spade-bot/other", "1.0.0", "sha256:ok"),
            false,
        ),
        (
            package(Source::Registry, "acme/deployer", "0.1.0", "sha256:ok"),
            true,
        ),
        (
            package(Source::Registry, "acme/deployer", "0.1.0", "sha256:bad"),
            false,
        ),
        (
            package(Source::Registry, "spade-bot/leaky", "0.1.0", "sha256:ok"),
            false,
        ),
        // Git catalogs carry no signature: off unless turned on.
        (
            package(Source::Git, "acme/deployer", "0.1.0", "sha256:ok"),
            false,
        ),
    ];
    for (package, allowed) in cases {
        assert_eq!(
            policy.package_refusal(package).is_none(),
            allowed,
            "{package:?}"
        );
    }
    // A bot already running a blocked version is paused, saying why.
    assert_eq!(
        policy
            .blocked("spade-bot/ci-watcher", "sha256:bad")
            .as_deref(),
        Some("Your organization blocked spade-bot/ci-watcher.")
    );
    // With no policy, only git is off.
    let open = Policy::parse("{}").unwrap_or_else(|| panic!("policy"));
    assert!(
        open.package_refusal(package(Source::Market, "x", "1", "sha256:ok"))
            .is_none()
    );
    assert!(
        open.package_refusal(package(Source::Git, "x", "1", "sha256:ok"))
            .is_some()
    );
}

#[test]
fn shared_bots_route_only_to_the_organizations_endpoints_and_never_to_a_subscription() {
    let policy =
        Policy::parse(r#"{"models": {"endpoints": ["api.example-models.com"], "local": false}}"#)
            .unwrap_or_else(|| panic!("policy"));
    assert!(
        policy
            .model_refusal(ModelPlace::Endpoint("API.example-models.com"))
            .is_none()
    );
    assert!(
        policy
            .model_refusal(ModelPlace::Endpoint("api.other.com"))
            .is_some()
    );
    assert!(policy.model_refusal(ModelPlace::Local).is_some());
    let open = Policy::parse("{}").unwrap_or_else(|| panic!("policy"));
    assert!(
        open.model_refusal(ModelPlace::Endpoint("api.other.com"))
            .is_none()
    );
    assert!(open.model_refusal(ModelPlace::Local).is_none());
    // Whatever the policy says.
    assert!(open.model_refusal(ModelPlace::Subscription).is_some());
}

#[test]
fn only_named_approvers_answer_and_a_list_always_keeps_one() {
    let mut access = Access::new("org_acme", "user_maker");
    access.approvers.push("user_ana".to_owned());
    let maker = member("user_maker", "member");
    let ana = member("user_ana", "member");
    let bob = member("user_bob", "member");
    let admin = member("user_root", "admin");
    let custom = member("user_odd", "org_reviewer");
    assert!(access.may(&maker, Right::Approve));
    assert!(access.may(&ana, Right::Approve));
    // No role approves without being named, owners and admins included.
    assert!(!access.may(&bob, Right::Approve));
    assert!(!access.may(&admin, Right::Approve));
    assert!(!access.may(&member("user_owner", "owner"), Right::Approve));
    // Configuring is the maker's and admins'; moving is admins'.
    assert!(access.may(&maker, Right::Configure));
    assert!(access.may(&admin, Right::Configure));
    assert!(!access.may(&ana, Right::Configure));
    assert!(access.may(&admin, Right::Move));
    assert!(!access.may(&maker, Right::Move));
    // A role ace doesn't know authorizes as a member.
    assert!(!access.may(&custom, Right::Move));
    assert!(access.may(&custom, Right::Talk));

    // Narrowed talk: the named, and those who answer or configure it.
    let narrowed = access
        .changed(
            Some(vec!["user_carol".to_owned()]),
            access.approvers.clone(),
            vec![],
        )
        .unwrap_or_else(|e| panic!("a list: {e}"));
    assert!(narrowed.may(&member("user_carol", "member"), Right::Talk));
    assert!(narrowed.may(&ana, Right::Talk));
    assert!(!narrowed.may(&bob, Right::Talk));
    assert_eq!(access.touched(&narrowed), vec!["talk"]);
    assert_eq!(
        access.changed(None, vec![], vec![]),
        Err(access::NO_APPROVER)
    );
    assert!(
        access
            .changed(None, vec!["not an account!".to_owned()], vec![])
            .is_err()
    );
}

#[test]
fn clubs_contracts_and_moves_stay_inside_one_space() {
    let acme = Space::Org("org_acme".to_owned());
    let other = Space::Org("org_other".to_owned());
    for what in [Crossing::Club, Crossing::Contract, Crossing::Move] {
        assert!(crossing(&acme, &acme, what).is_none());
        assert!(crossing(&Space::Personal, &Space::Personal, what).is_none());
        assert!(crossing(&acme, &other, what).is_some());
        assert!(crossing(&acme, &Space::Personal, what).is_some());
        assert!(crossing(&Space::Personal, &acme, what).is_some());
    }
}

/// A chain of `n` entries, as a host's store keeps it.
fn chain(n: i64) -> Vec<Chained> {
    let mut prev = GENESIS.to_owned();
    (1..=n)
        .map(|seq| {
            let entry = Entry::new(
                "bot.effect",
                1_000 + seq,
                Ref::new("bot", "a_1").named("CI watcher"),
                vec![
                    Ref::new("bot", "a_1"),
                    Ref::new("repo", "github.com/acme/app"),
                ],
            )
            .with("effect", "send_as_person")
            .with("allowed_by_account", "user_ana")
            .with("args_sha256", audit::digest(format!("{seq}").as_bytes()));
            let hash = audit::hash(&prev, &entry);
            let chained = Chained {
                seq,
                prev: prev.clone(),
                hash: hash.clone(),
                entry,
            };
            prev = hash;
            chained
        })
        .collect()
}

/// A stand-in for the host's key: the "signature" is a digest of the message and a secret.
fn sign(message: &[u8]) -> String {
    audit::digest(&[message, b"host key".as_slice()].concat())
}

fn signed(message: &[u8], signature: &str) -> bool {
    sign(message) == signature
}

fn export(entries: &[Chained], checkpoint_at: &[i64]) -> String {
    let mut lines = vec![Line::Header {
        org: "org_acme".to_owned(),
        host: "HOST".to_owned(),
        key: "k".to_owned(),
    }];
    for chained in entries {
        lines.push(Line::Entry(chained.clone()));
        if checkpoint_at.contains(&chained.seq) {
            let message =
                audit::checkpoint_message("org_acme", "HOST", chained.seq, &chained.hash, 9);
            lines.push(Line::Checkpoint(Checkpoint {
                count: chained.seq,
                head: chained.hash.clone(),
                at: 9,
                signature: sign(&message),
            }));
        }
    }
    lines
        .iter()
        .map(|line| serde_json::to_string(line).unwrap_or_else(|e| panic!("json: {e}")))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn an_audit_export_verifies_and_any_rewrite_before_its_checkpoint_is_found() {
    let entries = chain(6);
    let good = export(&entries, &[4]);
    assert_eq!(
        audit::verify(&good, &signed),
        Ok(audit::Verified {
            entries: 6,
            checkpoints: 1,
            unsigned: 2,
        })
    );

    // An edited entry no longer matches its own hash.
    let edited = good.replacen("user_ana", "user_bob", 1);
    assert_eq!(
        audit::verify(&edited, &signed).map_err(|b| b.why),
        Err("an entry was changed")
    );
    // Rewritten with every hash recomputed: the checkpoint's head is the old one.
    let mut rewritten = chain(6);
    rewritten[1].entry = rewritten[1]
        .entry
        .clone()
        .with("allowed_by_account", "user_bob");
    let mut prev = GENESIS.to_owned();
    for chained in &mut rewritten {
        chained.prev = prev.clone();
        chained.hash = audit::hash(&prev, &chained.entry);
        prev = chained.hash.clone();
    }
    let mut lines: Vec<String> = export(&rewritten, &[]).lines().map(str::to_owned).collect();
    let checkpoint = good
        .lines()
        .find(|line| line.contains("\"checkpoint\""))
        .unwrap_or_else(|| panic!("a checkpoint"))
        .to_owned();
    lines.insert(5, checkpoint);
    assert_eq!(
        audit::verify(&lines.join("\n"), &signed).map_err(|b| b.why),
        Err("the chain doesn't match a checkpoint")
    );
    // A dropped entry breaks the chain.
    let dropped: Vec<&str> = good
        .lines()
        .filter(|line| !line.contains("\"seq\":3"))
        .collect();
    assert_eq!(
        audit::verify(&dropped.join("\n"), &signed).map_err(|b| b.why),
        Err("an entry is missing")
    );
    // A checkpoint the host's key didn't sign.
    let forged = good.replacen("\"signature\":\"", "\"signature\":\"00", 1);
    assert_eq!(
        audit::verify(&forged, &signed).map_err(|b| b.why),
        Err("a checkpoint's signature isn't the host's")
    );
    // Not an export at all.
    assert!(audit::verify("", &signed).is_err());
}

#[test]
fn a_checkpoint_is_due_every_hundred_entries_or_five_minutes() {
    assert!(!audit::checkpoint_due(0, None, 10_000_000));
    assert!(!audit::checkpoint_due(99, Some(0), 1));
    assert!(audit::checkpoint_due(100, Some(0), 1));
    assert!(!audit::checkpoint_due(1, Some(0), audit::CHECKPOINT_MS - 1));
    assert!(audit::checkpoint_due(1, Some(0), audit::CHECKPOINT_MS));
}
