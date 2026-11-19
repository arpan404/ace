//! A selection or caret ace made in a text that the app doesn't show. GTK 4 apps on GNOME
//! lose a background window's selection: selecting claims the primary selection, which Mutter
//! cancels for any client without the keyboard focus, and GTK then collapses the selection.
//! GTK 4 text views before 4.22 also refuse to set a selection or caret through AT-SPI at all.
//! The helper keeps the range itself and applies it to the next delete, typing, cut, copy or
//! paste in that text, which take explicit ranges and work in the background.

/// A range ace selected (a caret when empty) in a text of `count` characters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Held {
    pub start: i32,
    pub end: i32,
    pub count: i32,
}

/// Where the next edit goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cursor {
    pub selection: Option<(i32, i32)>,
    pub caret: i32,
    /// Taken from the held range rather than the app.
    pub held: bool,
}

/// A held range, while the text still has the length it had (otherwise someone else edited
/// it and the range may be stale); else the app's own selection and caret. The helper holds a
/// range only between its own consecutive text steps, so the held one is the latest.
pub fn resolve(
    app_selection: Option<(i32, i32)>,
    app_caret: i32,
    held: Option<Held>,
    count: i32,
) -> Cursor {
    match held.filter(|h| h.count == count && 0 <= h.start && h.start <= h.end && h.end <= count) {
        Some(h) if h.end > h.start => Cursor {
            selection: Some((h.start, h.end)),
            caret: h.end,
            held: true,
        },
        Some(h) => Cursor {
            selection: None,
            caret: h.start,
            held: true,
        },
        None => Cursor {
            selection: app_selection,
            caret: app_caret,
            held: false,
        },
    }
}

/// The caret after Left, Right, Home or End pressed `repeat` times. A selection collapses to
/// its start (Left) or end (Right) on the first press. Home and End go to the text's ends.
pub fn moved(keysym: u32, cursor: Cursor, repeat: i32, count: i32) -> i32 {
    let repeat = repeat.max(1);
    match (keysym, cursor.selection) {
        (0xff51, Some((start, _))) => (start - (repeat - 1)).max(0),
        (0xff53, Some((_, end))) => (end + (repeat - 1)).min(count),
        (0xff51, None) => (cursor.caret - repeat).max(0),
        (0xff53, None) => (cursor.caret + repeat).min(count),
        (0xff50, _) => 0,
        _ => count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: Held = Held {
        start: 0,
        end: 10,
        count: 10,
    };

    #[test]
    fn without_a_held_range_the_app_decides() {
        let cursor = resolve(Some((2, 4)), 4, None, 10);
        assert_eq!(
            cursor,
            Cursor {
                selection: Some((2, 4)),
                caret: 4,
                held: false
            }
        );
    }

    #[test]
    fn a_held_caret_wins_over_a_selection_the_app_kept() {
        // ctrl+a shown on screen, then End the app refused: typing goes to the end.
        let cursor = resolve(
            Some((0, 10)),
            10,
            Some(Held {
                start: 10,
                end: 10,
                count: 10,
            }),
            10,
        );
        assert_eq!(
            cursor,
            Cursor {
                selection: None,
                caret: 10,
                held: true
            }
        );
    }

    #[test]
    fn a_dropped_selection_comes_from_the_held_range() {
        let cursor = resolve(None, 3, Some(ALL), 10);
        assert_eq!(
            cursor,
            Cursor {
                selection: Some((0, 10)),
                caret: 10,
                held: true
            }
        );
    }

    #[test]
    fn an_empty_held_range_is_a_caret() {
        let cursor = resolve(
            None,
            0,
            Some(Held {
                start: 6,
                end: 6,
                count: 10,
            }),
            10,
        );
        assert_eq!(
            cursor,
            Cursor {
                selection: None,
                caret: 6,
                held: true
            }
        );
    }

    #[test]
    fn a_held_range_is_stale_once_the_text_changes_length() {
        let cursor = resolve(Some((1, 2)), 3, Some(ALL), 11);
        assert_eq!(
            cursor,
            Cursor {
                selection: Some((1, 2)),
                caret: 3,
                held: false
            }
        );
        assert!(!resolve(None, 3, None, 10).held);
    }

    #[test]
    fn arrows_collapse_a_selection_then_move() {
        let selected = Cursor {
            selection: Some((2, 8)),
            caret: 8,
            held: true,
        };
        assert_eq!(moved(0xff51, selected, 1, 10), 2);
        assert_eq!(moved(0xff53, selected, 1, 10), 8);
        assert_eq!(moved(0xff51, selected, 5, 10), 0);
        assert_eq!(moved(0xff53, selected, 5, 10), 10);
        let caret = Cursor {
            selection: None,
            caret: 5,
            held: false,
        };
        assert_eq!(moved(0xff51, caret, 2, 10), 3);
        assert_eq!(moved(0xff53, caret, 9, 10), 10);
        assert_eq!(moved(0xff50, caret, 1, 10), 0);
        assert_eq!(moved(0xff57, caret, 1, 10), 10);
    }
}
