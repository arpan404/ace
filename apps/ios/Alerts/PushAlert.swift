import Foundation
import UserNotifications

/// A remote push as the push gateway sends it (ADR 0106): fixed "ace" / "New activity" text and
/// the daemon's RFC 8291 ciphertext in `ace.c`. The service extension replaces the text with the
/// alert the phone would have shown locally, or leaves it alone.
enum PushAlert {
    /// The ciphertext in a push's `userInfo`; nil when it isn't one of ace's v1 pushes.
    static func ciphertext(_ userInfo: [AnyHashable: Any]) -> Data? {
        guard let ace = userInfo["ace"] as? [String: Any], (ace["v"] as? Int) == 1,
              let text = ace["c"] as? String, text.count <= PushCrypto.maxBody * 2 else { return nil }
        return Data(base64URL: text)
    }

    /// The push's content with the decrypted alert's words, grouping, category, level and the
    /// same `userInfo` keys a local alert carries; nil whenever anything doesn't hold, so the
    /// caller keeps the gateway's generic text, which never says done. A push the gateway sent
    /// quietly stays quiet. Each rewritten alert is noted in `pushed`, so the app doesn't post
    /// it again when the socket brings it.
    static func rewritten(_ content: UNNotificationContent, key: PushKey?, pushed: PushedAlerts = PushedAlerts(defaults: nil)) -> UNNotificationContent? {
        guard let key, let body = ciphertext(content.userInfo), let plaintext = PushCrypto.decrypt(body, key: key),
              let alert = read(plaintext), let out = content.mutableCopy() as? UNMutableNotificationContent else { return nil }
        alert.content.fill(out)
        var info = alert.content.userInfo
        info[NotificationKeys.pushedAlert] = alert.pushedId
        info[NotificationKeys.standsFor] = alert.standsFor
        out.userInfo = info
        if content.interruptionLevel == .passive {
            out.interruptionLevel = .passive
            out.sound = nil
        }
        pushed.record(alert.pushedId)
        return out
    }

    struct Read {
        let content: AlertContent
        /// The identifier the app would post this alert under, for `PushedAlerts`.
        let pushedId: String
        /// The identifier the app withdraws it by: a thread's one notification, or a sign-in's.
        let standsFor: String
    }
    /// The decrypted payload: `{ v: 1, hostId, notification }` or `{ v: 1, hostId, access }`.
    /// Unknown fields are ignored and optional ones may be missing; a required one missing, or
    /// another version, reads as nothing.
    static func read(_ plaintext: Data) -> Read? {
        guard let payload = (try? JSONSerialization.jsonObject(with: plaintext)) as? [String: Any],
              (payload["v"] as? Int) == 1, let hostId = payload["hostId"] as? String, !hostId.isEmpty else { return nil }
        if let notification = payload["notification"] as? [String: Any] {
            guard let alert = alert(notification) else { return nil }
            let content = AlertContent(alert, hostId: hostId)
            return Read(content: content, pushedId: content.identifier, standsFor: AlertStack.thread(alert.threadId, hostId: hostId))
        }
        guard let (_, access) = AccessAlert.push(plaintext) else { return nil }
        let content = AlertContent.access(access, hostId: hostId, machine: nil)
        return Read(content: content, pushedId: content.identifier, standsFor: content.identifier)
    }

    /// The protocol's bounded `Notification`, read field by field.
    private static func alert(_ value: [String: Any]) -> AlertNotification? {
        guard let id = value["id"] as? String, !id.isEmpty, let threadId = value["threadId"] as? String, !threadId.isEmpty,
              let status = value["status"] as? String else { return nil }
        let actions = (value["actions"] as? [[String: Any]] ?? []).compactMap { action -> AlertNotification.Action? in
            guard let name = action["action"] as? String, let option = action["optionId"] as? String else { return nil }
            return AlertNotification.Action(action: name, optionId: option)
        }
        return AlertNotification(id: id, threadId: threadId, title: value["title"] as? String ?? "", status: status,
                                 interactionId: value["interactionId"] as? String,
                                 backgroundCount: value["backgroundCount"] as? Int ?? 0, actions: actions,
                                 preview: value["preview"] as? String, message: value["message"] as? String)
    }
}

/// Alerts the service extension already showed from a push, by the identifier the app would
/// post them under; kept in the app group's defaults, newest last and bounded. On screen or
/// swiped away, the person saw it: the app doesn't post it again (ADR 0106).
struct PushedAlerts: @unchecked Sendable {
    static let key = "ace.push.shown"
    static let capacity = 256
    let defaults: UserDefaults?

    static var appGroup: PushedAlerts { PushedAlerts(defaults: UserDefaults(suiteName: "group.app.ace.ios")) }

    func record(_ id: String) {
        guard let defaults else { return }
        var ids = defaults.stringArray(forKey: Self.key) ?? []
        ids.removeAll { $0 == id }
        ids.append(id)
        defaults.set(Array(ids.suffix(Self.capacity)), forKey: Self.key)
    }
    func contains(_ id: String) -> Bool { defaults?.stringArray(forKey: Self.key)?.contains(id) ?? false }
}
