import Foundation

/// The keyboard's motion as the system draws it, for what moves beside the system's keyboard
/// avoidance (the transcript's end, #2170). The notification names curve 7 and a duration
/// (0.383 s on iOS 26.1). Traced frame by frame on the iPhone 17 Pro simulator, the keyboard and
/// the composer it carries move as a critically damped spring whose response is 0.65 of that
/// duration, starting as the notification is posted.
enum KeyboardCurve {
    /// How long after the notification what the system draws starts to follow the curve, as seen
    /// from a value set for a frame's target time: the rows led the composer by two 60 Hz frames
    /// in every traced move without it.
    static let delay = 1.0 / 30

    /// The spring's response for a move the notification says lasts `duration` seconds.
    static func response(_ duration: Double) -> Double { duration * 0.65 }

    /// How far through its move the keyboard is `elapsed` seconds after the notification: 0 at
    /// the start, nearing 1 as it settles.
    static func progress(_ elapsed: Double, duration: Double) -> Double {
        guard elapsed > 0, duration > 0 else { return elapsed > 0 ? 1 : 0 }
        let x = 2 * Double.pi / response(duration) * elapsed
        return 1 - (1 + x) * exp(-x)
    }

    /// Whether a move of `distance` points is within half a point of its end `elapsed` seconds in.
    static func settled(_ elapsed: Double, duration: Double, distance: Double) -> Bool {
        (1 - progress(elapsed, duration: duration)) * abs(distance) < 0.5
    }
}
