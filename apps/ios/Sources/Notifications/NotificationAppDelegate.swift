import UIKit
import UserNotifications
import BackgroundTasks

/// Installs the notification delegate, categories and the background refresh task at launch,
/// which iOS requires before launch finishes.
final class NotificationAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    let coordinator = NotificationCoordinator()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories(NotificationActionID.categories)
        BackgroundRefresh.register(coordinator)
        return true
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let threadId = notification.request.content.userInfo[NotificationKeys.threadId] as? String
        return await MainActor.run { coordinator.presentation(for: threadId) }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let action = response.actionIdentifier
        let id = response.notification.request.identifier
        var info: [String: String] = [:]
        for (key, value) in response.notification.request.content.userInfo {
            if let key = key as? String, let value = value as? String { info[key] = value }
        }
        let values = info
        await coordinator.respond(action: action, notificationId: id, info: values)
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
