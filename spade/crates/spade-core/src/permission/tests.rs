use super::*;

fn own(computer_use: Option<bool>) -> Own {
    Own {
        computer_use,
        ..Own::default()
    }
}

#[test]
fn driving_is_off_until_the_person_turns_it_on_and_sends_and_payments_keep_asking() {
    let held = held([&Own::default()], Held::default());
    for switch in [Switch::ComputerUse, Switch::Browser, Switch::Devices] {
        assert!(!held.on(switch), "{switch:?}");
    }
    for switch in [Switch::Apps, Switch::Send, Switch::Pay] {
        assert!(held.on(switch), "{switch:?}");
    }
    // Settings stored by a build before Permissions read as no switch of the bot's own.
    let earlier: Own = serde_json::from_str(r#"{"unknown_switch": true}"#).unwrap_or_default();
    assert_eq!(earlier, Own::default());
}

#[test]
fn a_bot_follows_the_default_until_it_sets_its_own_and_a_worker_is_never_freer_than_its_parent() {
    let on = Held::default().over(&own(Some(true)));
    let off = Held::default();
    let cases: &[(&[Option<bool>], Held, bool)] = &[
        // A top bot: its own value over the default, either way.
        (&[None], on, true),
        (&[None], off, false),
        (&[Some(true)], off, true),
        (&[Some(false)], on, false),
        // A worker follows its parent unless it sets its own, and never turns on what its
        // parent has off.
        (&[Some(true), None], off, true),
        (&[Some(true), Some(false)], off, false),
        (&[Some(false), Some(true)], on, false),
        (&[None, Some(true)], off, false),
        (&[Some(true), None, Some(true)], off, true),
        (&[Some(true), Some(false), Some(true)], on, false),
    ];
    for (chain, machine, expected) in cases {
        let bots: Vec<Own> = chain.iter().map(|value| own(*value)).collect();
        assert_eq!(
            held(&bots, *machine).on(Switch::ComputerUse),
            *expected,
            "{chain:?} under {machine:?}"
        );
    }
}

#[test]
fn each_driving_family_has_its_own_switch() {
    assert_eq!(Switch::driving("screen_act"), Some(Switch::ComputerUse));
    assert_eq!(Switch::driving("screen_state"), Some(Switch::ComputerUse));
    assert_eq!(Switch::driving("browser_act"), Some(Switch::Browser));
    assert_eq!(Switch::driving("sim_act"), Some(Switch::Devices));
    assert_eq!(Switch::driving("workspace_write"), None);
    for switch in Switch::ALL {
        assert_eq!(Switch::parse(switch.key()), Some(switch));
    }
}

#[test]
fn the_never_use_list_keeps_names_once_and_says_what_a_change_lets_bots_use() {
    let given: Vec<String> = ["  1Password ", "1password", "", "Mail"]
        .iter()
        .map(|each| (*each).to_owned())
        .collect();
    assert_eq!(
        never::clean(&given),
        Ok(vec!["1Password".to_owned(), "Mail".to_owned()])
    );
    assert!(never::clean(&["bad\nname".to_owned()]).is_err());
    assert!(never::clean(&["x".repeat(81)]).is_err());
    let list = never::default_list();
    let mut next = list.clone();
    next.retain(|entry| entry != "1Password");
    next.push("Mail".to_owned());
    assert_eq!(never::dropped(&list, &next), vec!["1Password"]);
    // Adding only, or changing case, drops nothing.
    let louder: Vec<String> = list.iter().map(|entry| entry.to_uppercase()).collect();
    assert!(never::dropped(&list, &louder).is_empty());
}
