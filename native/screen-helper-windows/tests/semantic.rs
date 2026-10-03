use ace_screen_helper_windows::{
    coordinates::Bounds,
    errors::{Code, Error},
    semantic,
};
#[test]
fn only_an_unsupported_pattern_can_fall_back_and_the_reply_reports_its_centre() {
    let mut changed = false;
    let outcome = semantic::complete(Err(Error::new(Code::NotSupported, "No Invoke")), || {
        changed = true;
        Ok(Bounds {
            x: 12.0,
            y: 34.0,
            w: 0.0,
            h: 0.0,
        })
    })
    .unwrap();
    assert!(changed);
    assert!(outcome.fallback);
    assert_eq!(outcome.bounds_centre.unwrap().x, 12.0);
    for code in [
        Code::PermissionDenied,
        Code::TargetGone,
        Code::Busy,
        Code::Timeout,
        Code::Internal,
        Code::Bounds,
    ] {
        let result = semantic::complete(Err(Error::new(code.clone(), "failed")), || {
            panic!("must not inject")
        });
        assert_eq!(result.unwrap_err().code, code);
    }
    let result = semantic::complete(Ok(()), || panic!("semantic action already worked")).unwrap();
    assert!(!result.fallback);
}
