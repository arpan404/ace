import AppIntents
import UIKit
import UserNotifications
import BackgroundTasks

/// Installs the notification delegate, categories and the background refresh task at launch,
/// which iOS requires before launch finishes.
final class NotificationAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    let coordinator = NotificationAppDelegate.makeCoordinator()
    /// Talk to Spade's hand-off from its intent to the inbox (`SpadeTalkHandoff`).
    let spadeTalk = SpadeTalkHandoff()

    /// The app's notifications. A `--spike-unpaired` launch keeps its settings in scratch defaults
    /// and touches nothing outside the process: no lock screen or widgets, no app group, no
    /// background connections.
    private static func makeCoordinator() -> NotificationCoordinator {
        guard SpikeConfiguration.unpaired else { return NotificationCoordinator(lockScreenEdges: .system, pushed: .appGroup) }
        return NotificationCoordinator(defaults: UnpairedScratch.defaults, connectInBackground: { _ in [] }, lockScreenEdges: .inert)
    }

    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        // Siri's Ask Spade reaches the machines through the coordinator; Talk to Spade hands off.
        let coordinator = coordinator, spadeTalk = spadeTalk
        AppDependencyManager.shared.add(dependency: coordinator)
        AppDependencyManager.shared.add(dependency: spadeTalk)
        // Nothing registered for a fresh-install fixture: categories, background refresh and push
        // would write the app's real defaults and register with iOS.
        if SpikeConfiguration.unpaired { return true }
        center.setNotificationCategories(NotificationCategories.remember(nil, defaults: .standard))
        BackgroundRefresh.register(coordinator)
        coordinator.requestPushToken = { application.registerForRemoteNotifications() }
        return true
    }
    // Remote push (ADR 0106). iOS gives a token on every registration and it can change; each
    // machine's sync carries it with this phone's push key.
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        // Without the app group (an unsigned build) the extension couldn't decrypt: no address.
        guard let key = try? PushKeyStore.appGroup?.loadOrCreate() else { return }
        coordinator.registeredForPush(PushRegistration(token: deviceToken, environment: .current, key: key))
    }
    /// No `aps-environment` (a free team, or `ACE_PUSH` off), or no network: local alerts carry on.
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        coordinator.registeredForPush(nil)
    }
    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                     fetchCompletionHandler completion: @escaping @Sendable (UIBackgroundFetchResult) -> Void) {
        guard !SpikeConfiguration.unpaired, application.applicationState != .active,
              let body = PushAlert.ciphertext(userInfo), let key = PushKeyStore.appGroup?.read(),
              let plaintext = PushCrypto.decrypt(body, key: key), let push = PushAlert.read(plaintext) else {
            completion(.noData)
            return
        }
        // UIKit can wake the app before the extension finishes. The same alert should never
        // interrupt twice even if the feed reaches the app first.
        PushedAlerts.appGroup.record(push.pushedId)
        coordinator.scene(active: false)
        Task { @MainActor in
            let caught = await coordinator.backgroundCatchUp()
            completion(caught ? .newData : .failed)
        }
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
        let access = info[NotificationKeys.accessRequestId] as? String
        Task { @MainActor in
            if let access { completionHandler(coordinator.accessPresentation(access, hostId: hostId)); return }
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
                if UIApplication.shared.applicationState != .active { coordinator.scene(active: false) }
                schedule()
                let work = Task { @MainActor in
                    let caught = await coordinator.backgroundCatchUp()
                    task.setTaskCompleted(success: caught && !Task.isCancelled)
                }
                task.expirationHandler = { work.cancel() }
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
