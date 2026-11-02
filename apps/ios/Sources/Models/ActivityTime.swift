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
    /// Work under way, to the second, as the desktop row counts it (`formatElapsed`): "38s",
    /// "1m 34s", "1h 2m".
    static func running(since start: Date, now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(start).rounded()))
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m \(seconds % 60)s" }
        return "\(minutes / 60)h \(minutes % 60)m"
    }
    /// A row's age at rest: "now" under a minute, then "9m", "2h", "3d"; a week or more is the
    /// short date.
    static func age(since start: Date, now: Date, locale: Locale = .current) -> String {
        if now.timeIntervalSince(start) >= 7 * 86_400 {
            var style = Date.FormatStyle.dateTime.month(.abbreviated).day()
            style.locale = locale
            return start.formatted(style)
        }
        return elapsed(since: start, now: now, locale: locale) ?? "now"
    }
}
