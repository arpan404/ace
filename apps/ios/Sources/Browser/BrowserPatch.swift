import Foundation

/// A box in the page's viewport, in the CSS pixels input coordinates use.
struct PageRect: Codable, Sendable, Equatable {
    let x: Double; let y: Double; let width: Double; let height: Double
}

/// What the page shows besides its pixels (`browser.page`): the focused field, an open picker,
/// the pointer's cursor and a tooltip. The latest for the shown tab replaces the previous one.
struct BrowserPageInfo: Codable, Sendable, Equatable {
    struct Focus: Codable, Sendable, Equatable {
        let type: String
        let rect: PageRect
        var caret: PageRect? = nil
        var inputMode: String? = nil
        var enterKeyHint: String? = nil
    }
    struct Picker: Codable, Sendable, Equatable {
        struct Option: Codable, Sendable, Equatable {
            let value: String
            let label: String
            var disabled: Bool? = nil
            var group: String? = nil
        }
        let pickerId: String
        /// select, date, time, datetime-local, month, week or color.
        let kind: String
        let rect: PageRect
        let value: String
        var options: [Option]? = nil
        var min: String? = nil
        var max: String? = nil
        var step: String? = nil
    }
    struct Tooltip: Codable, Sendable, Equatable { let text: String; let x: Double; let y: Double }
    var focus: Focus? = nil
    var picker: Picker? = nil
    var cursor: String? = nil
    var tooltip: Tooltip? = nil
}

/// The thread's browser as the live view shows it (`bridge/browser-live.ts`).
struct BrowserViewInfo: Codable, Sendable, Equatable {
    struct Tab: Codable, Sendable, Equatable, Identifiable { let id: String; let title: String; let url: String }
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
    }
    /// Bumped whenever the daemon starts this viewer's pictures again.
    let generation: Int
    /// Why the browser can't be watched yet (none open); retried while the view is shown.
    let error: String?
    let state: State?
}

enum BrowserPatch: Decodable, Sendable, Equatable {
    case view(threadId: String, BrowserViewInfo)
    case page(threadId: String, tabId: String?, BrowserPageInfo?)
    /// Whether the thread has a browser with a tab open, for its Browser entry.
    case available(threadId: String, epoch: Int, live: Bool)

    static let types: Set<String> = ["browser.view", "browser.page", "browser.available"]
    private enum Keys: String, CodingKey { case type, threadId, tabId, page, epoch, live }
    init(from decoder: any Decoder) throws {
        let box = try decoder.container(keyedBy: Keys.self)
        let threadId = try box.decode(String.self, forKey: .threadId)
        switch try box.decode(String.self, forKey: .type) {
        case "browser.view": self = .view(threadId: threadId, try BrowserViewInfo(from: decoder))
        case "browser.page":
            self = .page(threadId: threadId, tabId: try box.decodeIfPresent(String.self, forKey: .tabId),
                         try box.decodeIfPresent(BrowserPageInfo.self, forKey: .page))
        case "browser.available":
            self = .available(threadId: threadId, epoch: try box.decode(Int.self, forKey: .epoch), live: try box.decode(Bool.self, forKey: .live))
        default: throw DecodingError.dataCorruptedError(forKey: .type, in: box, debugDescription: "Unknown browser patch")
        }
    }
}
