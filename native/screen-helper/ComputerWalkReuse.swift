import ApplicationServices

/// What was true when a window was last walked: how many accessibility notifications the app
/// had sent (including the helper's own changes), when, which window with which frame, and
/// which element had focus.
struct CUWalkStamp: Equatable {
    let events: UInt64
    let at: UInt64
    let window: CUElementKey?
    let frame: CGRect?
    let focused: CUElementKey?
}

/// A repeated look within `maxAgeNs` reuses the last walk when nothing could have changed: the
/// app sent no notification at all (every notification is registered), the helper did nothing,
/// and the same window, frame and focus are current. Apps that change without telling
/// accessibility are covered by the short age limit.
func cuWalkStillCurrent(last: CUWalkStamp?, now: CUWalkStamp, maxAgeNs: UInt64, observingEverything: Bool) -> Bool {
    guard observingEverything, let last, now.at >= last.at, now.at - last.at <= maxAgeNs else { return false }
    return last.events == now.events && last.window == now.window && last.frame == now.frame && last.focused == now.focused
}
