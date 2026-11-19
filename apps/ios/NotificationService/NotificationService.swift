import UserNotifications

/// The Notification Service Extension (ADR 0106). The push gateway's alert always reads "ace" /
/// "New activity"; this decrypts the daemon's payload with the phone's push key and shows the
/// alert the app would have posted locally. Anything that doesn't hold (no key after a
/// reinstall, a tampered or unreadable payload) leaves the generic text, which never says done.
///
/// The work is a few hundred bytes of CryptoKit and JSON, done before `didReceive` returns, so
/// iOS's time limit never cuts it short and `serviceExtensionTimeWillExpire` has nothing left
/// to hand over.
final class NotificationService: UNNotificationServiceExtension {
    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        let key = PushKeyStore.appGroup?.read()
        contentHandler(PushAlert.rewritten(request.content, key: key, pushed: .appGroup) ?? request.content)
    }
}
