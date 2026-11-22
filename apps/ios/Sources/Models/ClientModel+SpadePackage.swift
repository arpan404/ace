import Foundation

/// A bot linked to an agent package, as its profile shows it (`bridge/spade-package.ts`).
struct SpadePackageLine: Decodable, Equatable, Sendable {
    /// A declared effect as its switch.
    struct Effect: Decodable, Equatable, Hashable, Identifiable, Sendable {
        let key: String
        /// "Reaches api.example-fares.com".
        let words: String
        let why: String
        let on: Bool
        /// A send, a payment or an access change still goes to the person every time.
        let eachTime: Bool
        var id: String { key }
    }
    /// "From flight-watcher 1.0.0 in the Marketplace."
    let sentence: String
    let name: String
    /// The Marketplace's newer version, while the bot can take it.
    let update: String?
    /// The version Roll back returns to.
    let rollBack: String?
    let withdrawn: Bool
    /// A template bot's newer template from its Spade.
    let template: String?
    let effects: [Effect]
}

/// A template update's review: what changes, what stays because the person or the bot changed
/// it, and what it asks for, with each declared effect in words.
struct SpadeTemplateOffer: Decodable, Equatable, Sendable {
    struct Effect: Decodable, Equatable, Hashable, Sendable {
        let words: String
        let why: String
    }
    /// The very version reviewed, sent back as it came so only it is taken.
    struct Identity: Codable, Equatable, Sendable {
        let source: String
        let name: String
        let version: String
        let hash: String
    }
    let name: String
    let version: String
    let changes: [String]
    let kept: [String]
    let more: [String]
    let effects: [Effect]
    let identity: Identity
}

struct SpadePackageAnswer: Decodable, Sendable {
    let ok: Bool
    let title: String?
    let message: String?
    /// `spade.package`: nil for a bot that isn't from a package (and on a refusal).
    let package: SpadePackageLine?
    /// `spade.template`.
    let offer: SpadeTemplateOffer?
    var problem: String? { SpadeOutcome(ok: ok, title: title, message: message).problem }
}

/// A packaged bot's line, its declared effects and a template bot's update (`bridge/spade-package.ts`).
extension ClientModel {
    private func spadePackageCall(_ payload: [String: Any], failing title: String) async -> SpadePackageAnswer {
        do { return try await service(payload, as: SpadePackageAnswer.self) }
        catch is CancellationError { return SpadePackageAnswer(ok: false, title: title, message: nil, package: nil, offer: nil) }
        catch { return SpadePackageAnswer(ok: false, title: title, message: error.localizedDescription, package: nil, offer: nil) }
    }

    func spadePackage(_ agent: String) async -> SpadePackageAnswer {
        await spadePackageCall(["type": "spade.package", "agentId": agent], failing: "Couldn't read its package")
    }

    /// One declared effect's switch: on is the person's grant, off narrows it.
    func spadePackageEffect(_ agent: String, key: String, on: Bool) async -> SpadeOutcome {
        await spadeRequest(["type": "spade.package.effect", "agentId": agent, "key": key, "on": on],
                           failing: on ? "Couldn't turn it on" : "Couldn't turn it off")
    }

    func spadeTemplateOffer(_ agent: String) async -> SpadePackageAnswer {
        await spadePackageCall(["type": "spade.template", "agentId": agent], failing: "Couldn't read the update")
    }

    /// Takes the very template version the person reviewed.
    func spadeTakeTemplate(_ agent: String, _ offer: SpadeTemplateOffer) async -> SpadeOutcome {
        let identity = offer.identity
        let package: [String: Any] = ["source": identity.source, "name": identity.name,
                                      "version": identity.version, "hash": identity.hash]
        return await spadeRequest(["type": "spade.template.take", "agentId": agent, "package": package],
                                  failing: "Couldn't update it")
    }
}
