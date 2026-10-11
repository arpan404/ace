//! Pointer dispatch policy, with native pointer facts and injection supplied at the edge.
use crate::protocol::Result;
pub trait Pointer {
    fn motion(&mut self, x: f64, y: f64) -> Result<()>;
    fn verify(&mut self) -> Result<()>;
    fn button(&mut self, button: u8, pressed: bool) -> Result<()>;
}
fn pulse(io: &mut impl Pointer, button: u8) -> Result<()> {
    io.verify()?;
    let pressed = io.button(button, true);
    let released = io.button(button, false);
    pressed
        .and(released)
        .map_err(|error| error.phase("partial"))
}
pub fn click(io: &mut impl Pointer, x: f64, y: f64, button: u8) -> Result<()> {
    io.motion(x, y)?;
    pulse(io, button)
}
pub fn drag(io: &mut impl Pointer, x: f64, y: f64, to_x: f64, to_y: f64) -> Result<()> {
    // Check both endpoints before grabbing the pointer with a press.
    io.motion(to_x, to_y)?;
    io.verify()?;
    io.motion(x, y)?;
    io.verify()?;
    let pressed = io.button(1, true);
    let moved = pressed.and_then(|_| io.motion(to_x, to_y));
    let released = io.button(1, false);
    moved.and(released).map_err(|error| error.phase("partial"))
}
pub fn scroll(io: &mut impl Pointer, x: f64, y: f64, dx: f64, dy: f64) -> Result<()> {
    if dx == 0. && dy == 0. {
        return Ok(());
    }
    io.motion(x, y)?;
    let mut dispatched = false;
    for (delta, negative, positive) in [(dy, 4, 5), (dx, 6, 7)] {
        for _ in 0..delta.abs().ceil() as u32 {
            if let Err(error) = pulse(io, if delta < 0. { negative } else { positive }) {
                return Err(if dispatched {
                    error.phase("partial")
                } else {
                    error
                });
            }
            dispatched = true;
        }
    }
    Ok(())
}
