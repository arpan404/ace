use ace_screen_helper_linux::{
    pointer_route::{self, Pointer},
    protocol::{Fault, Result},
};
#[derive(Default)]
struct Desktop {
    position: (f64, f64),
    covered: bool,
    effects: Vec<(u8, bool, &'static str)>,
    fail_press: bool,
    fail_motion: bool,
    cover_after_wheel: bool,
}
impl Pointer for Desktop {
    fn motion(&mut self, x: f64, y: f64) -> Result<()> {
        if self.fail_motion && !self.effects.is_empty() {
            return Err(Fault::new("internal", "motion failed"));
        }
        self.position = (x, y);
        Ok(())
    }
    fn verify(&mut self) -> Result<()> {
        if self.covered || self.position != (10., 10.) && self.position != (20., 20.) {
            Err(Fault::new("busy", "unapproved destination"))
        } else {
            Ok(())
        }
    }
    fn button(&mut self, button: u8, pressed: bool) -> Result<()> {
        self.effects.push((
            button,
            pressed,
            if self.covered || self.position == (0., 0.) {
                "unapproved"
            } else {
                "approved"
            },
        ));
        if self.cover_after_wheel && button >= 4 && !pressed {
            self.covered = true;
        }
        if self.fail_press && pressed {
            Err(Fault::new("internal", "press failed"))
        } else {
            Ok(())
        }
    }
}
#[test]
fn scroll_moves_from_an_unapproved_window_to_the_verified_target() {
    let mut desktop = Desktop::default();
    pointer_route::scroll(&mut desktop, 10., 10., 0., 1.).unwrap();
    assert_eq!(
        desktop.effects,
        vec![(5, true, "approved"), (5, false, "approved")]
    );
}
#[test]
fn covered_clicks_and_drags_refuse_before_any_button_press() {
    for drag in [false, true] {
        let mut desktop = Desktop {
            covered: true,
            ..Desktop::default()
        };
        let result = if drag {
            pointer_route::drag(&mut desktop, 10., 10., 20., 20.)
        } else {
            pointer_route::click(&mut desktop, 10., 10., 1)
        };
        assert!(result.is_err());
        assert!(desktop.effects.is_empty());
    }
}
#[test]
fn unobscured_input_works_and_partial_failures_always_attempt_release() {
    let mut desktop = Desktop::default();
    pointer_route::click(&mut desktop, 10., 10., 1).unwrap();
    assert_eq!(
        desktop.effects,
        vec![(1, true, "approved"), (1, false, "approved")]
    );
    for fail_press in [false, true] {
        let mut desktop = Desktop {
            fail_press,
            fail_motion: true,
            ..Desktop::default()
        };
        assert!(pointer_route::drag(&mut desktop, 10., 10., 20., 20.).is_err());
        assert_eq!(desktop.effects.last(), Some(&(1, false, "approved")));
    }
}

#[test]
fn later_scroll_refusal_reports_partial_dispatch_without_pressing_the_covering_window() {
    let mut desktop = Desktop {
        cover_after_wheel: true,
        ..Desktop::default()
    };
    let error = pointer_route::scroll(&mut desktop, 10., 10., 0., 2.).unwrap_err();
    assert_eq!(error.phase, Some("partial"));
    assert_eq!(
        desktop.effects,
        vec![(5, true, "approved"), (5, false, "approved")]
    );
}
#[test]
fn zero_scroll_keeps_the_pointer_where_the_human_left_it() {
    let mut desktop = Desktop::default();
    pointer_route::scroll(&mut desktop, 10., 10., 0., 0.).unwrap();
    assert_eq!(desktop.position, (0., 0.));
    assert!(desktop.effects.is_empty());
}
