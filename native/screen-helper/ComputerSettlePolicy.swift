/// When waiting for an app to settle may stop. Pure: times are uptime nanoseconds.
///
/// The wait lasts at least `minimumNs` and at most until `limit`. After the helper's own last
/// change (a click, a key), an app that has not reacted yet gets the full `quietNs` to start
/// reacting. Once it has reacted, it only needs to stay quiet for `respondedQuietNs` after its
/// last notification: an app that answers in 10 ms and then goes quiet is settled at about
/// 10 + `respondedQuietNs` ms instead of `quietNs`.
struct CUSettleWindow {
    let started: UInt64
    let minimumNs: UInt64
    let quietNs: UInt64
    let respondedQuietNs: UInt64
    let limit: UInt64

    func settled(now: UInt64, lastHelperChange: UInt64, lastAppChange: UInt64?) -> Bool {
        if now >= limit { return true }
        guard now >= started, now - started >= minimumNs else { return false }
        if let app = lastAppChange, app >= lastHelperChange {
            return now >= app && now - app >= respondedQuietNs
        }
        let last = max(lastHelperChange, lastAppChange ?? 0)
        return now >= last && now - last >= quietNs
    }
}

/// Text edits and selection changes confirm their own delivery. Navigation, clicks, menus
/// and conditions still need a settled UI before the next step can depend on their result.
func cuConsecutiveEdits(_ current: CUObject, _ next: CUObject) -> Bool {
    let edits: Set<String> = ["type", "paste", "set_value", "select_text", "focus"]
    guard next["when"] == nil, let first = current.string("type"), let second = next.string("type"),
          edits.contains(first), edits.contains(second) else { return false }
    // Return/Tab in typed text can submit a form or move focus just like a named key.
    return !(current.string("text") ?? "").contains(where: { $0 == "\n" || $0 == "\r" || $0 == "\t" })
}

/// An explicit wait owns its synchronization. A skipped conditional performed no
/// side effect. Neither needs an additional whole-app quiet interval between steps.
func cuNeedsSettleAfter(_ current: CUObject, next: CUObject, skipped: Bool) -> Bool {
    if skipped { return false }
    if next["when"] == nil, ["wait", "wait_for"].contains(next.string("type") ?? "") { return false }
    return !cuConsecutiveEdits(current, next)
}
