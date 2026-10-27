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

enum BrowserPatch: Decodable, Sendable, Equatable {
    case view(threadId: String, BrowserViewInfo)
    case page(threadId: String, tabId: String?, BrowserPageInfo?)
    /// Whether the thread has a browser with a tab open, for its Browser entry.
    case available(threadId: String, epoch: Int, live: Bool)
    /// Find in page's count ("2 of 5").
    case find(BrowserFindResult)
    case shot(BrowserShot)
    case logs(BrowserLog)
    /// The history sheet's visits matching its search, and how many there are in all.
    case visits(threadId: String, [BrowserVisit], total: Int)
    /// A command that failed, in one sentence.
    case problem(BrowserProblem)
    /// Files for a page's picker uploading, 0 to 1.
    case upload(chooserId: String, progress: Double)
    /// The devices the device toolbar offers, sent once per view; ones that don't read are left out.
    case presets([BrowserViewInfo.Device.Preset])
    case done(BrowserDone)
    case source(BrowserSource?)
    case sizes(BrowserSizes?)
    case extensions(BrowserExtensions?)
    case saving(BrowserSaving)
    /// The page's own Send in annotate mode: go to the message.
    case annotateSend(at: Double)

    static let types: Set<String> = ["browser.view", "browser.page", "browser.available", "browser.find", "browser.shot",
                                     "browser.logs", "browser.visits", "browser.problem", "browser.upload",
                                     "browser.presets", "browser.done", "browser.source", "browser.sizes",
                                     "browser.extensions", "browser.saving", "browser.annotateSend"]
    private enum Keys: String, CodingKey { case type, threadId, tabId, page, epoch, live, visits, total, chooserId, progress, presets, at }
    init(from decoder: any Decoder) throws {
        let box = try decoder.container(keyedBy: Keys.self)
        let threadId = { try box.decode(String.self, forKey: .threadId) }
        switch try box.decode(String.self, forKey: .type) {
        case "browser.view": self = .view(threadId: try threadId(), try BrowserViewInfo(from: decoder))
        case "browser.page":
            self = .page(threadId: try threadId(), tabId: try box.decodeIfPresent(String.self, forKey: .tabId),
                         try box.decodeIfPresent(BrowserPageInfo.self, forKey: .page))
        case "browser.available":
            self = .available(threadId: try threadId(), epoch: try box.decode(Int.self, forKey: .epoch), live: try box.decode(Bool.self, forKey: .live))
        case "browser.find": self = .find(try BrowserFindResult(from: decoder))
        case "browser.shot": self = .shot(try BrowserShot(from: decoder))
        case "browser.logs": self = .logs(try BrowserLog(from: decoder))
        case "browser.visits":
            self = .visits(threadId: try threadId(), try box.decode([BrowserVisit].self, forKey: .visits), total: try box.decode(Int.self, forKey: .total))
        case "browser.problem": self = .problem(try BrowserProblem(from: decoder))
        case "browser.upload":
            self = .upload(chooserId: try box.decode(String.self, forKey: .chooserId), progress: try box.decode(Double.self, forKey: .progress))
        case "browser.presets":
            self = .presets((try? box.decode(Lenient<BrowserViewInfo.Device.Preset>.self, forKey: .presets).items) ?? [])
        case "browser.done": self = .done(try BrowserDone(from: decoder))
        case "browser.source": self = .source(try? BrowserSource(from: decoder))
        case "browser.sizes": self = .sizes(try? BrowserSizes(from: decoder))
        case "browser.extensions": self = .extensions(try? BrowserExtensions(from: decoder))
        case "browser.saving": self = .saving(try BrowserSaving(from: decoder))
        case "browser.annotateSend": self = .annotateSend(at: try box.decode(Double.self, forKey: .at))
        default: throw DecodingError.dataCorruptedError(forKey: .type, in: box, debugDescription: "Unknown browser patch")
        }
    }
}
