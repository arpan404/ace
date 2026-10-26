import Foundation

/// The thread's browser as the phone shows it (`bridge/browser-view.ts`): its tabs, who uses the
/// shown one, and whatever stands between the person and its page. Swift draws it as sent.
struct BrowserViewInfo: Codable, Sendable, Equatable {
    struct Tab: Codable, Sendable, Equatable, Identifiable {
        let id: String
        let title: String
        let url: String
        var host: String? = nil
        var loading: Bool? = nil
        /// The agent using the tab now, by name.
        var agent: String? = nil
        /// The person kept agents out of it (took it over).
        var `private`: Bool? = nil
    }
    /// The shown tab's controls and who has it.
    struct Shown: Codable, Sendable, Equatable {
        let canGoBack: Bool
        let canGoForward: Bool
        /// "110%" when not at 100%.
        let zoom: String?
        let agent: String?
        let `private`: Bool
        /// Where the agent last pointed, in the page's CSS pixels, when the phone draws its cursor.
        let pointer: Pointer?
    }
    struct Pointer: Codable, Sendable, Equatable { let x: Double; let y: Double; let sequence: Int }
    /// A failed load or an untrusted certificate, as a person reads it.
    struct Failure: Codable, Sendable, Equatable { let title: String; let detail: String; let url: String; let host: String }
    struct Dialog: Codable, Sendable, Equatable, Identifiable {
        let dialogId: String
        let tabId: String
        /// alert, confirm, prompt or beforeunload.
        let type: String
        let message: String
        let defaultPrompt: String
        let site: String
        let otherTab: Bool
        var id: String { dialogId }
    }
    struct SignIn: Codable, Sendable, Equatable, Identifiable {
        let authId: String
        let tabId: String
        let site: String
        let realm: String?
        let otherTab: Bool
        var id: String { authId }
    }
    struct Chooser: Codable, Sendable, Equatable, Identifiable {
        let chooserId: String
        let tabId: String
        let multiple: Bool
        let site: String
        let otherTab: Bool
        var id: String { chooserId }
    }
    struct Download: Codable, Sendable, Equatable, Identifiable {
        let id: String
        let filename: String
        /// One word: Downloading, Downloaded, Blocked, Failed, Too large.
        let state: String
        let failed: Bool
        let bytes: Int
        let risky: Bool
    }
    struct State: Codable, Sendable, Equatable {
        let url: String
        let closed: Bool
        /// ready, paused or recovering.
        let status: String
        let reason: String?
        let loading: Bool
        let loadError: String?
        let activeTabId: String?
        let tabs: [Tab]
        let moreTabs: Int
        var address: String? = nil
        var addressUrl: String? = nil
        var addressHost: String? = nil
        var blank: Bool? = nil
        var shown: Shown? = nil
        var disconnected: Bool? = nil
        var failure: Failure? = nil
        var certificate: Failure? = nil
        var dialog: Dialog? = nil
        var auth: SignIn? = nil
        var chooser: Chooser? = nil
        var permission: String? = nil
        var downloads: [Download]? = nil
        var downloading: Int? = nil
    }
    /// The device the shown tab is shown as (`bridge/browser-device.ts`), and the device toolbar.
    struct Device: Codable, Sendable, Equatable {
        struct Preset: Codable, Sendable, Equatable, Identifiable {
            let id: String
            let label: String
            /// phone, tablet or computer.
            let kind: String
            let width: Int
            let height: Int
        }
        let toolbar: Bool
        /// The preset the tab is, either way up, or "this-phone" (the view's own size); nil for any other.
        let preset: String?
        let label: String
        /// The tab's emulated size; nil while the page follows another screen's pane.
        let width: Int?
        let height: Int?
        /// False for the person's own Chrome, which ace never resizes.
        let supported: Bool
    }
    /// Bumped whenever the daemon starts this viewer's pictures again.
    let generation: Int
    /// Why the browser can't be watched yet (none open); retried while the view is shown.
    let error: String?
    let state: State?
    var device: Device? = nil

    private enum CodingKeys: String, CodingKey { case generation, error, state, device }
}

extension BrowserViewInfo {
    /// The device toolbar is read on its own: one that doesn't decode hides the toolbar, never the browser.
    init(from decoder: any Decoder) throws {
        let box = try decoder.container(keyedBy: CodingKeys.self)
        generation = try box.decode(Int.self, forKey: .generation)
        error = try box.decodeIfPresent(String.self, forKey: .error)
        state = try box.decodeIfPresent(State.self, forKey: .state)
        device = (try? box.decodeIfPresent(Device.self, forKey: .device)) ?? nil
    }
}

/// One-shot answers from the browser's tools (`bridge/browser-tools.ts`).
struct BrowserFindResult: Codable, Sendable, Equatable { let text: String; let message: String }
struct BrowserShot: Codable, Sendable, Equatable { let at: Double; let data: String?; let path: String }
struct BrowserProblem: Codable, Sendable, Equatable { let at: Double; let message: String }
struct BrowserLog: Codable, Sendable, Equatable {
    struct Entry: Codable, Sendable, Equatable, Identifiable {
        let key: String
        /// error, warning or info for console lines; nil for requests.
        let level: String?
        let text: String
        let url: String?
        let status: String
        let method: String
        let size: String
        let time: String
        let failed: Bool
        var id: String { key }
    }
    let section: String
    let entries: [Entry]
}
struct BrowserVisit: Codable, Sendable, Equatable, Identifiable {
    let url: String
    let title: String
    let at: Double
    var id: String { "\(at):\(url)" }
}
