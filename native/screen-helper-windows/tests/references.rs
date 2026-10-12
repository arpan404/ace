use ace_screen_helper_windows::references::References;
#[derive(Clone)]
struct Control {
    lifetime: usize,
    live: bool,
}
#[test]
fn a_recycled_runtime_id_retires_the_old_reference_without_retargeting_it() {
    let mut refs = References::new(2);
    let first = refs.retain(
        "same-runtime-id".into(),
        Control {
            lifetime: 1,
            live: false,
        },
    );
    let replacement = refs.retain_if_same(
        "same-runtime-id".into(),
        Control {
            lifetime: 2,
            live: true,
        },
        |old, new| old.live && old.lifetime == new.lifetime,
    );
    assert_ne!(first, replacement);
    assert!(refs.get(&first).is_none());
    assert_eq!(refs.get(&replacement).unwrap().lifetime, 2);
    let refresh = refs.retain_if_same(
        "same-runtime-id".into(),
        Control {
            lifetime: 2,
            live: true,
        },
        |old, new| old.live && old.lifetime == new.lifetime,
    );
    assert_eq!(replacement, refresh);
    refs.clear();
    assert!(refs.get(&replacement).is_none());
    let next = refs.retain(
        "same-runtime-id".into(),
        Control {
            lifetime: 3,
            live: true,
        },
    );
    assert_ne!(next, replacement);
}
