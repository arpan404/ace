import Foundation

// The marketplace's calls (`bridge/market.ts`): every v1 operation as one `market.native`
// request to this machine's daemon. Reads are kept between visits (`bridge/read-policy.ts`),
// so a screen draws `kept…` first and reads again when `marketGeneration` moves, which the
// daemon's `marketplace.changed` and every install or removal do.
private struct MarketOutcome: Decodable {
    let ok: Bool
    let offline: Bool?
    let code: String?
    let message: String?
    let way: MarketWay?
    let reason: String?
}

extension ClientModel {
    /// One market operation, its answer decoded as `T` or its refusal thrown as `MarketRefusal`.
    /// `confirmed` is the person's Confirm it's you: the bridge sends that change once more only.
    /// `request` adds the bridge's own fields to the request beside the operation.
    func market<T: Decodable>(_ operation: [String: Any], as type: T.Type, fresh: Bool = false,
                              confirmed: Bool = false, request: [String: Any] = [:]) async throws -> T {
        var payload = marketPayload(operation, fresh: fresh).merging(request) { $1 }
        if confirmed { payload["confirmed"] = true }
        let changes = marketChanges(operation["op"])
        // Not connected: a change can't leave the phone, so nothing changed.
        if changes, connection != "ready" {
            throw MarketRefusal(code: "offline", message: "Your machine is offline. Nothing was changed.", way: .retry, offline: true)
        }
        do {
            // A change waits past the bridge's own check of a lost reply (`bridge/market.ts`).
            let value = marketKept(operation["op"]) ? try await read(payload, as: ServiceValue.self)
                : try await service(payload, as: ServiceValue.self, timeout: changes ? .seconds(90) : .seconds(30))
            return try marketAnswer(value, as: type)
        } catch let refusal as MarketRefusal { throw refusal }
        catch is CancellationError { throw CancellationError() }
        catch let failure as ServiceFailure where failure.transport {
            // A change sent and then lost may have happened: never say it didn't, or offer Retry.
            if changes {
                throw MarketRefusal(code: "unconfirmed", message: "Couldn't confirm it: your machine stopped answering. Check again when it's back.",
                                    way: .reread, offline: true)
            }
            throw MarketRefusal(code: "offline", message: "Your machine is offline.", way: .retry, offline: true)
        }
    }
    /// The last kept answer to a read, for the first frame.
    func keptMarket<T: Decodable>(_ operation: [String: Any], as type: T.Type) -> T? {
        kept(marketPayload(operation, fresh: false), as: ServiceValue.self).flatMap { try? marketAnswer($0, as: type) }
    }
    /// Moves whenever the market's kept reads go out of date.
    var marketGeneration: Int { familyGeneration("market") }

    // Browse (#2500).
    func marketDiscover(fresh: Bool = false) async throws -> MarketDiscover {
        try await market(["op": "discover"], as: MarketDiscover.self, fresh: fresh)
    }
    var keptMarketDiscover: MarketDiscover? { keptMarket(["op": "discover"], as: MarketDiscover.self) }
    func marketHome(fresh: Bool = false) async throws -> MarketHome { try await market(["op": "home"], as: MarketHome.self, fresh: fresh) }
    var keptMarketHome: MarketHome? { keptMarket(["op": "home"], as: MarketHome.self) }
    /// One page of results from `offset`; `reviewedOnly` lists only what ace reviewed, filtered by
    /// the bridge before the page is cut, as a category lists them.
    func marketSearch(query: String, type: String? = nil, category: String? = nil, offset: Int = 0,
                      reviewedOnly: Bool = false, fresh: Bool = false) async throws -> MarketSearchPage {
        var operation: [String: Any] = ["op": "search", "query": query, "offset": offset]
        if let type { operation["type"] = type }
        if let category { operation["category"] = category }
        return try await market(operation, as: MarketSearchPage.self, fresh: fresh,
                                request: reviewedOnly ? ["reviewedOnly": true] : [:])
    }
    func marketPublisher(_ handle: String, fresh: Bool = false) async throws -> MarketPublisherPage {
        try await market(["op": "publisher", "handle": handle], as: MarketPublisherPage.self, fresh: fresh)
    }
    func keptMarketPublisher(_ handle: String) -> MarketPublisherPage? {
        keptMarket(["op": "publisher", "handle": handle], as: MarketPublisherPage.self)
    }
    /// A listing picture or an avatar by its hash; `kind` is `preview` or `avatar`.
    func marketPicture(_ hash: String, kind: String) async throws -> MarketPicture {
        try await market(["op": "picture", "kind": kind, "hash": hash], as: MarketPicture.self)
    }
    func marketSources(fresh: Bool = false) async throws -> MarketSources {
        try await market(["op": "sources"], as: MarketSources.self, fresh: fresh)
    }
    var keptMarketSources: MarketSources? { keptMarket(["op": "sources"], as: MarketSources.self) }
    func marketAddSource(_ address: String) async throws -> MarketSources {
        try await market(["op": "addSource", "address": address], as: MarketSources.self)
    }
    func marketRemoveSource(_ id: String) async throws -> MarketSources {
        try await market(["op": "removeSource", "id": id], as: MarketSources.self)
    }
    func marketSetSource(_ id: String, enabled: Bool) async throws -> MarketSources {
        try await market(["op": "setSource", "id": id, "enabled": enabled], as: MarketSources.self)
    }
    /// Pull to refresh: the machine reads its sources again (one, or every one).
    func marketRefresh(_ id: String? = nil) async throws -> MarketSources {
        var operation: [String: Any] = ["op": "refresh"]
        if let id { operation["id"] = id }
        return try await market(operation, as: MarketSources.self)
    }

    // Entry page and install (#2501).
    func marketEntry(_ key: MarketEntryKey) async throws -> MarketEntryPage {
        try await market(key.operation.merging(["op": "read"]) { $1 }, as: MarketEntryPage.self)
    }
    func keptMarketEntry(_ key: MarketEntryKey) -> MarketEntryPage? {
        keptMarket(key.operation.merging(["op": "read"]) { $1 }, as: MarketEntryPage.self)
    }
    func marketPrepare(_ key: MarketEntryKey) async throws -> MarketReview {
        try await market(key.operation.merging(["op": "prepare"]) { $1 }, as: MarketPrepared.self).review
    }
    func marketPrepareUpdate(_ key: MarketInstalledKey) async throws -> MarketReview {
        try await market(key.operation.merging(["op": "prepareUpdate"]) { $1 }, as: MarketPrepared.self).review
    }
    func marketPrepareRollback(_ key: MarketInstalledKey) async throws -> MarketReview {
        try await market(key.operation.merging(["op": "prepareRollback"]) { $1 }, as: MarketPrepared.self).review
    }
    func marketReviewPage(_ id: String, offset: Int) async throws -> MarketReviewPage {
        try await market(["op": "readReview", "id": id, "offset": offset], as: MarketReviewPage.self)
    }
    /// Install with the person's choices (`MarketInstallChoices`): bots, needs, routines, effects.
    func marketInstall(_ review: MarketReview, choices: [String: Any], confirmed: Bool = false) async throws -> MarketInstall? {
        try await market(["op": "install", "id": review.id, "hash": review.hash, "choices": choices], as: MarketDone.self,
                         confirmed: confirmed).installed
    }
    func marketCancel(_ review: MarketReview) async throws {
        _ = try await market(["op": "cancel", "id": review.id], as: MarketDone.self)
    }

    // Installed and updates (#2502), bots approval (#2503).
    func marketInstalled(fresh: Bool = false) async throws -> MarketInstalledList {
        try await market(["op": "installed"], as: MarketInstalledList.self, fresh: fresh)
    }
    var keptMarketInstalled: MarketInstalledList? { keptMarket(["op": "installed"], as: MarketInstalledList.self) }
    func marketRemove(_ key: MarketInstalledKey) async throws {
        _ = try await market(key.operation.merging(["op": "remove"]) { $1 }, as: MarketDone.self)
    }
    func marketTurnOn(_ key: MarketInstalledKey) async throws -> MarketInstall? {
        try await market(key.operation.merging(["op": "turnOn"]) { $1 }, as: MarketDone.self).installed
    }
    /// Turns exactly this installed version of a Spade skill on for the person's bots.
    /// A version installed since `row` was read is refused as `conflict`, to read it again.
    func marketTurnOnForBots(_ row: MarketInstall, confirmed: Bool = false) async throws -> MarketInstall? {
        try await market(["op": "turnOnForBots", "name": row.name, "hash": row.hash], as: MarketDone.self,
                         confirmed: confirmed).installed
    }

    private func marketPayload(_ operation: [String: Any], fresh: Bool) -> [String: Any] {
        var payload: [String: Any] = ["type": "market.native", "operation": operation]
        if fresh { payload["fresh"] = true }
        return payload
    }
}

/// The operations that change the machine; the rest only read or hold a review.
private func marketChanges(_ op: Any?) -> Bool {
    guard let op = op as? String else { return false }
    return ["install", "cancel", "remove", "turnOn", "turnOnForBots", "addSource", "removeSource", "setSource", "refresh"].contains(op)
}

/// The reads the bridge keeps (`bridge/read-policy.ts` `marketReads`).
private func marketKept(_ op: Any?) -> Bool {
    guard let op = op as? String else { return false }
    return ["discover", "home", "search", "read", "publisher", "sources", "installed"].contains(op)
}

func marketAnswer<T: Decodable>(_ value: ServiceValue, as type: T.Type) throws -> T {
    let outcome = try value.decode(MarketOutcome.self)
    guard outcome.ok else {
        throw MarketRefusal(code: outcome.code ?? "failed", message: outcome.message ?? "The machine refused that.",
                            way: outcome.way, offline: outcome.offline ?? false, reason: outcome.reason)
    }
    return try value.decode(type)
}
