//! Native pointer destination checks for XTest, whose button events are global.
use crate::{
    pointer_route::Pointer,
    protocol::{Fault, Result, internal},
    x11::{Window, X11},
};
use x11rb::{CURRENT_TIME, NONE, protocol::xproto::*};
pub(crate) struct TargetPointer<'a> {
    pub backend: &'a X11,
    pub target: &'a Window,
}
impl Pointer for TargetPointer<'_> {
    fn motion(&mut self, x: f64, y: f64) -> Result<()> {
        self.backend.motion(self.target, x, y)
    }
    fn verify(&mut self) -> Result<()> {
        self.backend.check(self.target)?;
        let denied = || {
            Fault::new(
                "busy",
                "Pointer destination is covered, grabbed, or outside the approved window",
            )
            .phase("rejected-before-dispatch")
        };
        let root = self
            .backend
            .conn
            .query_pointer(self.backend.root)
            .map_err(internal)?
            .reply()
            .map_err(internal)?;
        let buttons = KeyButMask::BUTTON1
            | KeyButMask::BUTTON2
            | KeyButMask::BUTTON3
            | KeyButMask::BUTTON4
            | KeyButMask::BUTTON5;
        if !root.same_screen || u16::from(root.mask & buttons) != 0 {
            return Err(denied());
        }
        // QueryPointer follows the visible child at the current pointer, including WM frames.
        let mut child = root.child;
        let mut belongs = false;
        for _ in 0..64 {
            if child == self.target.id {
                belongs = true;
                break;
            }
            if child == NONE {
                break;
            }
            let pointer = self
                .backend
                .conn
                .query_pointer(child)
                .map_err(internal)?
                .reply()
                .map_err(internal)?;
            if !pointer.same_screen {
                break;
            }
            child = pointer.child;
        }
        if !belongs {
            return Err(denied());
        }
        // Detect another client's explicit pointer grab. Release our probe before injection.
        let grabbed = self
            .backend
            .conn
            .grab_pointer(
                false,
                self.backend.root,
                EventMask::NO_EVENT,
                GrabMode::ASYNC,
                GrabMode::ASYNC,
                NONE,
                NONE,
                CURRENT_TIME,
            )
            .map_err(internal)?
            .reply()
            .map_err(internal)?;
        if grabbed.status != GrabStatus::SUCCESS {
            return Err(denied());
        }
        self.backend
            .conn
            .ungrab_pointer(CURRENT_TIME)
            .map_err(internal)?
            .check()
            .map_err(internal)?;
        self.backend.check(self.target).map(|_| ())
    }
    fn button(&mut self, button: u8, pressed: bool) -> Result<()> {
        self.backend.fake(
            if pressed {
                BUTTON_PRESS_EVENT
            } else {
                BUTTON_RELEASE_EVENT
            },
            button,
            0,
            0,
        )
    }
}
