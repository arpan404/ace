import Foundation

extension ClientModel {
    /// One Work write for the open thread (`bridge/work-actions.ts`), sent once. Returns the request
    /// id its `work.result` will carry, or nil when this phone may not act or the bridge refused it.
    func workAction(_ action: [String: Any]) -> String? {
        guard canOperate else { return nil }
        let id = "work-\(UUID().uuidString)"
        return sheet(["kind": "work.action", "action": action, "requestId": id]) ? id : nil
    }
    /// "Clear stale lock" for the open thread, once the person confirmed. Its outcome arrives as a
    /// `work.result` with the returned id.
    func clearStaleLock() -> String? {
        guard canOperate else { return nil }
        let id = "lock-\(UUID().uuidString)"
        return sheet(["kind": "lock.clear", "requestId": id]) ? id : nil
    }
}
