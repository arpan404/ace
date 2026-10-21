import Foundation

/// How long a thread's tree has worked, in the reader's locale, beside its status word.
enum ActivityTime {
    /// The largest whole unit ("12m", "3h"). Nil under a minute, and for a start the phone's
    /// clock hasn't reached yet (a daemon clock slightly ahead never reads as the future).
    static func elapsed(since start: Date, now: Date, locale: Locale = .current) -> String? {
        let seconds = now.timeIntervalSince(start)
        guard seconds >= 60 else { return nil }
        // Whole units only, rounded down: 3h 59m reads "3h", never "4h".
        let unit: Double = seconds >= 86_400 ? 86_400 : seconds >= 3600 ? 3600 : 60
        let whole = (seconds / unit).rounded(.down) * unit
        var style = Duration.UnitsFormatStyle(allowedUnits: [.days, .hours, .minutes], width: .narrow, maximumUnitCount: 1)
        style.locale = locale
        return Duration.seconds(whole).formatted(style)
    }
}
