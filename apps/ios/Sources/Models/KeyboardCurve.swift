import Foundation

/// The keyboard's motion, for the composer and the transcript's end that ride it (#2170). The
/// notification names curve 7 and a duration (0.383 s on iOS 26.1). Traced frame by frame on the
/// iPhone 17 Pro simulator, the keyboard's edge starts about 18 ms after the notification, then
/// closes the distance left by a near-constant share each frame: an ease-out at a rate of 15.5 per
/// second for that duration. Over five traced 311 pt moves that is within about 20 pt (32 pt on a
/// heavily loaded machine). A spring starting from rest fit worse: it starts too slowly.
enum KeyboardCurve {
    /// How long after the notification the keyboard starts to move.
    static let delay = 0.018

    /// The ease-out's rate for a move the notification says lasts `duration` seconds.
    static func rate(_ duration: Double) -> Double { 5.94 / duration }

    /// How far through its move the keyboard is `elapsed` seconds after the notification: 0 until
    /// it starts, nearing 1 as it settles.
    static func progress(_ elapsed: Double, duration: Double) -> Double {
        let moving = elapsed - delay
        guard moving > 0 else { return 0 }
        guard duration > 0 else { return 1 }
        return 1 - exp(-rate(duration) * moving)
    }

    /// Whether a move of `distance` points is within half a point of its end `elapsed` seconds in.
    static func settled(_ elapsed: Double, duration: Double, distance: Double) -> Bool {
        (1 - progress(elapsed, duration: duration)) * abs(distance) < 0.5
    }
}
