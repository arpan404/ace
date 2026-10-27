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
        var muted: Bool? = nil
        var audible: Bool? = nil
        /// The page as the composer's `@` mention leaves it; nil while agents are kept out.
        var mention: Mention? = nil
    }
    /// "Ask agent about this page": the words it inserts and the tab it points at.
    struct Mention: Codable, Sendable, Equatable { let label: String; let tabId: String; let url: String; let title: String }
    struct Recording: Codable, Sendable, Equatable {
        /// A person started it (they can stop it); else an agent did.
        let byPerson: Bool
        /// This phone started it.
        let here: Bool
    }
    /// Annotate mode as the bar offers it; nil when the daemon can't annotate pages.
    struct Annotate: Codable, Sendable, Equatable {
        /// off, starting or on.
        let mode: String
        /// Why the page can't be annotated now, in words.
        let unavailable: String?
        /// Another screen annotates this page.
        let elsewhere: Bool
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
        /// Finished and small enough to save onto this phone.
        var saveable: Bool? = nil
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
        /// The person's own Chrome: ace never prints, clears or reads its source.
        var ownChrome: Bool? = nil
        var recording: Recording? = nil
        var annotate: Annotate? = nil
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
/// A finished command, said once (`browser.done`): "PDF saved to this thread" and the file.
struct BrowserDone: Codable, Sendable, Equatable { let at: Double; let message: String; let detail: String? }
/// The shown page's source, as the server sent it (`browser.source`).
struct BrowserSource: Codable, Sendable, Equatable { let url: String; let source: String; let truncated: Bool }
/// Screenshots at several sizes (`browser.sizes`); nil images while they are taken.
struct BrowserSizes: Codable, Sendable, Equatable {
    struct Image: Codable, Sendable, Equatable, Identifiable {
        let size: String
        let width: Int
        let height: Int
        /// Base64 JPEG.
        let data: String
        var id: String { size }
    }
    let at: Double
    let images: [Image]?
}
/// The engine's extensions as it reports them (`browser.extensions`); nil while read.
struct BrowserExtensions: Codable, Sendable, Equatable {
    struct Item: Codable, Sendable, Equatable, Identifiable { let id: String; let name: String; let version: String?; let enabled: Bool }
    let items: [Item]?
}
/// A download being copied onto this phone (`browser.saving`).
struct BrowserSaving: Codable, Sendable, Equatable {
    /// A download id is its thread's own: the same id in another thread is another file.
    let threadId: String
    let downloadId: String
    let name: String
    /// saving, ready or failed.
    let phase: String
    let progress: Double
    let message: String?
    /// The bridge's id for the phone's copy (`SavedFiles`), and the key saves are kept under.
    var key: String { Self.key(threadId: threadId, downloadId: downloadId) }
    static func key(threadId: String, downloadId: String) -> String { "\(threadId)/\(downloadId)" }
}
struct BrowserVisit: Codable, Sendable, Equatable, Identifiable {
    let url: String
    let title: String
    let at: Double
    var id: String { "\(at):\(url)" }
}
