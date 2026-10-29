import Foundation

/// One styled run of GitHub text (`bridge/forge-rich-inline.ts`).
struct ForgeRun: Decodable, Sendable, Equatable, Hashable {
    let text: String
    var b: Bool? = nil
    var i: Bool? = nil
    var s: Bool? = nil
    var code: Bool? = nil
    var kbd: Bool? = nil
    var sup: Bool? = nil
    var sub: Bool? = nil
    var u: Bool? = nil
    var mark: Bool? = nil
    var link: String? = nil
}

/// An image GitHub text shows: its light source, a dark one when the text gives one, and its size.
struct ForgeImageRef: Decodable, Sendable, Equatable, Hashable {
    let src: String
    let dark: String?
    let alt: String
    let width: Double?
    let height: Double?
}

/// One block of GitHub text as the bridge decided to draw it (`bridge/forge-rich.ts`).
indirect enum ForgeRichBlock: Decodable, Sendable, Equatable {
    struct Item: Decodable, Sendable, Equatable {
        struct Task: Decodable, Sendable, Equatable { let checked: Bool; let offset: Int? }
        let task: Task?
        let blocks: [ForgeRichBlock]
    }
    struct Note: Decodable, Sendable, Equatable { let number: Int; let runs: [ForgeRun] }

    case paragraph(runs: [ForgeRun], align: String?)
    case heading(level: Int, runs: [ForgeRun])
    case code(lang: String, text: String)
    case mermaid(text: String)
    case quote(blocks: [ForgeRichBlock])
    case alert(kind: String, blocks: [ForgeRichBlock])
    case list(ordered: Bool, start: Int, items: [Item])
    case table(head: [[ForgeRun]], rows: [[[ForgeRun]]])
    case rule
    case image(ForgeImageRef)
    case video(src: String)
    case media(url: String, runs: [ForgeRun])
    case details(summary: [ForgeRun], open: Bool, blocks: [ForgeRichBlock])
    case footnotes(notes: [Note])
    case unknown

    private enum Keys: String, CodingKey { case k, runs, align, level, lang, text, blocks, kind, ordered, start, items, head, rows, src, url, summary, open, notes }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .k) {
        case "p": self = .paragraph(runs: try c.decode([ForgeRun].self, forKey: .runs), align: try c.decodeIfPresent(String.self, forKey: .align))
        case "h": self = .heading(level: try c.decode(Int.self, forKey: .level), runs: try c.decode([ForgeRun].self, forKey: .runs))
        case "code": self = .code(lang: try c.decode(String.self, forKey: .lang), text: try c.decode(String.self, forKey: .text))
        case "mermaid": self = .mermaid(text: try c.decode(String.self, forKey: .text))
        case "quote": self = .quote(blocks: try c.decode([ForgeRichBlock].self, forKey: .blocks))
        case "alert": self = .alert(kind: try c.decode(String.self, forKey: .kind), blocks: try c.decode([ForgeRichBlock].self, forKey: .blocks))
        case "list":
            self = .list(ordered: try c.decode(Bool.self, forKey: .ordered), start: try c.decode(Int.self, forKey: .start),
                         items: try c.decode([Item].self, forKey: .items))
        case "table": self = .table(head: try c.decode([[ForgeRun]].self, forKey: .head), rows: try c.decode([[[ForgeRun]]].self, forKey: .rows))
        case "rule": self = .rule
        case "image": self = .image(try ForgeImageRef(from: decoder))
        case "video": self = .video(src: try c.decode(String.self, forKey: .src))
        case "media": self = .media(url: try c.decode(String.self, forKey: .url), runs: try c.decode([ForgeRun].self, forKey: .runs))
        case "details":
            self = .details(summary: try c.decode([ForgeRun].self, forKey: .summary), open: try c.decode(Bool.self, forKey: .open),
                            blocks: try c.decode([ForgeRichBlock].self, forKey: .blocks))
        case "footnotes": self = .footnotes(notes: try c.decode([Note].self, forKey: .notes))
        // A block a newer bridge adds is skipped, never fatal.
        default: self = .unknown
        }
    }
}

/// Media bytes the daemon fetched for GitHub text (`forge.media`).
struct ForgeMediaBytes: Decodable, Sendable, Equatable {
    /// `ready`, `none` (a plain link) or `unavailable`.
    let state: String
    let kind: String?
    let mimeType: String?
    let width: Double?
    let height: Double?
    let data: String?
    let reason: String?
}

/// Where GitHub text is drawn: its machine's client and project, the repository its media and
/// links belong to.
@MainActor struct ForgeRichScope {
    let client: ClientModel
    let project: String
    let repository: ForgeRepository?

    func media(_ url: String, role: String) async -> ForgeMediaBytes? {
        let request = ClientModel.on(repository, ["type": "forge.media", "project": project, "url": url, "role": role])
        return try? await client.service(request, as: ForgeMediaBytes.self)
    }
}

extension ClientModel {
    /// Tick or untick one task box, in the text the phone showed. Sent once.
    func forgeTask(project: String, number: Int, repository: ForgeRepository, on: [String: Any], offset: Int, checked: Bool) async -> ForgeReviewOutcome {
        guard canOperate else { return ForgeReviewOutcome(ok: false, message: "View only. Pair this phone with View and act to tick boxes.", uncertain: false) }
        let request: [String: Any] = ["type": "forge.task", "project": project, "number": number, "repository": repository.json,
                                      "on": on, "offset": offset, "checked": checked]
        do { return try await service(request, as: ForgeReviewOutcome.self) }
        catch { return ForgeReviewOutcome(ok: false, message: error.localizedDescription, uncertain: false) }
    }
}
