import Foundation

/// What a Spade request came to (`bridge/spade-requests.ts`): done, or refused with a title and
/// why, in the person's words.
struct SpadeOutcome: Decodable, Sendable {
    let ok: Bool
    /// A bot just made: it and its one conversation.
    let agentId: String?
    let conversationId: String?
    let title: String?
    let message: String?
    /// Spade may have it: the answer was lost, and nothing says what it made. The form keeps its
    /// words under `note`, never sent again on its own.
    let unknown: Bool?
    let note: String?
    /// A picture's bytes, as base64 (`spade.image`).
    let data: String?
    init(ok: Bool, agentId: String? = nil, conversationId: String? = nil, title: String? = nil, message: String? = nil,
         unknown: Bool? = nil, note: String? = nil, data: String? = nil) {
        self.ok = ok; self.agentId = agentId; self.conversationId = conversationId; self.title = title
        self.message = message; self.unknown = unknown; self.note = note; self.data = data
    }

    /// What the person reads when it didn't go: the note when Spade may have it, else why.
    var words: String? {
        if ok { return nil }
        if let note { return note }
        let said = [title, message].compactMap(\.self).filter { !$0.isEmpty }
        return said.isEmpty ? nil : said.joined(separator: ". ")
    }
}

/// Settings › Spade and the new-bot form: each endpoint Spade knows, its key line and its models,
/// the models a bot can run on, and the colours a bot's face can take.
struct SpadeModels: Decodable, Sendable {
    struct KeyLine: Decodable, Equatable, Sendable {
        let description: String
        let canSave: Bool
        let canRemove: Bool
        let placeholder: String
    }
    struct Model: Decodable, Equatable, Sendable, Identifiable {
        let id: String
        let name: String
        /// Its context and what it can do beyond text, when known.
        let facts: String?
    }
    struct Endpoint: Decodable, Equatable, Sendable, Identifiable {
        let id: String
        let name: String
        /// Nil when the endpoint needs no key.
        let key: KeyLine?
        let models: [Model]
    }
    /// A model a new bot can run on: `endpoint/model`, and its name with its endpoint's.
    struct Choice: Decodable, Equatable, Sendable, Identifiable {
        let ref: String
        let label: String
        var id: String { ref }
    }
    struct Colour: Decodable, Equatable, Sendable, Identifiable {
        let id: String
        /// `#RRGGBB`.
        let fill: String
    }
    let ok: Bool
    let endpoints: [Endpoint]?
    let choices: [Choice]?
    let colors: [Colour]?
    let title: String?
    let message: String?
    init(ok: Bool, endpoints: [Endpoint]? = nil, choices: [Choice]? = nil, colors: [Colour]? = nil, title: String? = nil, message: String? = nil) {
        self.ok = ok; self.endpoints = endpoints; self.choices = choices; self.colors = colors; self.title = title; self.message = message
    }
}

extension ClientModel {
    /// A Spade place shows (the tab, Settings › Spade), or no longer does.
    func spadeWatch(_ on: Bool) {
        spade.watchers = max(0, spade.watchers + (on ? 1 : -1))
        action(["type": "spade.watch", "on": on])
    }
    /// Follow `bot`'s one conversation live, or none.
    func spadeOpen(_ bot: SpadeModel.Opened?) {
        guard spade.opened != bot else { return }
        spade.opened = bot
        action(["type": "spade.open", "bot": bot.map { Self.payload($0) as Any } ?? NSNull()])
    }
    func spadeRetry() { action(["type": "spade.retry"]) }
    /// Read Spade's state, the setting and the roster again now.
    func spadeRefresh() { action(["type": "spade.refresh"]) }
    /// A new runtime knows nothing of what shows: tell it again.
    func spadeResume() {
        for _ in 0..<spade.watchers { action(["type": "spade.watch", "on": true]) }
        if let bot = spade.opened { action(["type": "spade.open", "bot": Self.payload(bot)]) }
    }
    /// A Spade request; a transport failure reads as a refusal with its words.
    func spadeRequest(_ payload: [String: Any], failing title: String) async -> SpadeOutcome {
        do { return try await service(payload, as: SpadeOutcome.self, timeout: .seconds(70)) }
        catch is CancellationError { return SpadeOutcome(ok: false) }
        catch { return SpadeOutcome(ok: false, title: title, message: error.localizedDescription) }
    }
    func spadeModels() async -> SpadeModels {
        do { return try await service(["type": "spade.models"], as: SpadeModels.self) }
        catch { return SpadeModels(ok: false, title: "Couldn't read Spade's models", message: error.localizedDescription) }
    }
    /// A bot's uploaded face, read once and kept for this runtime.
    func spadeFace(_ sha256: String) async -> Data? {
        if let kept = spade.faces[sha256] { return kept }
        let outcome = await spadeRequest(["type": "spade.image", "sha256": sha256], failing: "Couldn't read the picture")
        guard let data = outcome.data.flatMap({ Data(base64Encoded: $0) }) else { return nil }
        spade.faces[sha256] = data
        return data
    }

    private static func payload(_ bot: SpadeModel.Opened) -> [String: Any] {
        ["agentId": bot.agentId, "conversationId": bot.conversationId]
    }
}
