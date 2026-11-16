import Foundation

/// The keyboard's motion, for the composer and the transcript's end that ride it (#2170). The
/// notification names curve 7 and a duration (0.383 s on iOS 26.1). Traced frame by frame on the
/// iPhone 17 Pro simulator, the keyboard's edge starts a little after the notification, then
/// closes the distance left by a near-constant share each frame: an ease-out at a rate of about
/// 15.5 per second for that duration, within about 10 to 20 pt of each traced 311 pt move. A
/// spring starting from rest fit worse: it starts too slowly.
///
/// The composer rides this, so where the fit is off it should err on the side that keeps it above
/// the keyboard, never under it: an opening starts early and a closing late.
enum KeyboardCurve {
    /// How long after the notification an opening keyboard's ride starts.
    static let openingDelay = 0.012
    /// How long after the notification a closing keyboard's ride starts.
    static let closingDelay = 0.030

    /// The ease-out's rate for a move the notification says lasts `duration` seconds.
    static func rate(_ duration: Double) -> Double { 5.94 / duration }

    /// How far through its move the keyboard is `elapsed` seconds after the notification, for a
    /// ride that starts `delay` seconds in: 0 until then, nearing 1 as it settles.
    static func progress(_ elapsed: Double, duration: Double, delay: Double) -> Double {
        let moving = elapsed - delay
        guard moving > 0 else { return 0 }
        guard duration > 0 else { return 1 }
        return 1 - exp(-rate(duration) * moving)
    }

    /// Whether a ride of `distance` points is within half a point of its end `elapsed` seconds in.
    static func settled(_ elapsed: Double, duration: Double, delay: Double, distance: Double) -> Bool {
        (1 - progress(elapsed, duration: duration, delay: delay)) * abs(distance) < 0.5
    }
}
