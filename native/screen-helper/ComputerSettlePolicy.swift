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
