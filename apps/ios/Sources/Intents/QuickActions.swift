import UIKit

/// The Home Screen quick actions (long-press the icon): New thread and New chat. Each becomes the
/// `ace://new` link the app already opens, so it lands where every New thread link lands.
enum QuickAction {
    static let newThread = "app.ace.new-thread"
    static let newChat = "app.ace.new-chat"

    static func link(_ type: String) -> URL? {
        switch type {
        case newThread: URL(string: "ace://new")
        case newChat: URL(string: "ace://new?project=\(NewThreadDraft.chat)")
        default: nil
        }
    }
}

/// Hands quick actions to the app as links: one picked at launch waits until the window is up.
final class QuickActionSceneDelegate: NSObject, UIWindowSceneDelegate {
    private var waiting: URL?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        waiting = options.shortcutItem.flatMap { QuickAction.link($0.type) }
    }
    func sceneDidBecomeActive(_ scene: UIScene) {
        guard let url = waiting else { return }
        waiting = nil
        UIApplication.shared.open(url)
    }
    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem) async -> Bool {
        guard let url = QuickAction.link(shortcutItem.type) else { return false }
        await UIApplication.shared.open(url)
        return true
    }
}

extension NotificationAppDelegate {
    /// Every window gets the quick-action delegate beside SwiftUI's own.
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: nil, sessionRole: session.role)
        configuration.delegateClass = QuickActionSceneDelegate.self
        return configuration
    }
}
