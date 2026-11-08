import UIKit
import UserNotifications
import BackgroundTasks

/// Installs the notification delegate, categories and the background refresh task at launch,
/// which iOS requires before launch finishes.
final class NotificationAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    let coordinator = NotificationCoordinator(lockScreenEdges: .system)

    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories(NotificationCategories.remember(nil, defaults: .standard))
        BackgroundRefresh.register(coordinator)
        return true
    }
    // The completion-handler forms, called back on the main thread: UIKit's handlers update the
    // app's snapshot and must run there. The async forms are resumed off the main thread when the
    // method isn't on the main actor, and UIKit stops the app (a tapped notification crashed it).
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping @Sendable (UNNotificationPresentationOptions) -> Void) {
        let info = notification.request.content.userInfo
        let threadId = info[NotificationKeys.threadId] as? String
        let hostId = info[NotificationKeys.hostId] as? String
        let banner = info[NotificationKeys.banner] as? String != "0"
        Task { @MainActor in
            completionHandler(coordinator.presentation(for: threadId, hostId: hostId, banner: banner))
        }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping @Sendable () -> Void) {
        let action = response.actionIdentifier
        let id = response.notification.request.identifier
        var info: [String: String] = [:]
        for (key, value) in response.notification.request.content.userInfo {
            if let key = key as? String, let value = value as? String { info[key] = value }
        }
        let values = info
        let text = (response as? UNTextInputNotificationResponse)?.userText
        Task { @MainActor in
            await coordinator.respond(action: action, notificationId: id, info: values, text: text)
            completionHandler()
        }
    }
}

/// BGAppRefreshTask: iOS decides when it runs. Each run connects briefly, catches up on missed
/// alerts and disconnects inside the task's time budget.
enum BackgroundRefresh {
    static let identifier = "app.ace.ios.notifications.refresh"

    @MainActor static func register(_ coordinator: NotificationCoordinator) {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { task in
            nonisolated(unsafe) let task = task
            MainActor.assumeIsolated {
                schedule()
                let work = Task { @MainActor in
                    let caught = await coordinator.backgroundCatchUp()
                    task.setTaskCompleted(success: caught)
                }
                task.expirationHandler = {
                    work.cancel()
                    Task { @MainActor in await coordinator.releaseTransient() }
                }
            }
        }
    }
    /// Asked for whenever the app leaves the foreground; iOS may run it later or never.
    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }
}
