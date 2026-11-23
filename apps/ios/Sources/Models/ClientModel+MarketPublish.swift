import Foundation

// Publishing and managing listings (#2548, #2554): each screen's step as one `market.publish`
// request (`bridge/market-publishing.ts`). Nothing here is kept between visits: the publisher's
// own pages are read fresh, and offline they say so.
extension ClientModel {
    /// One publish step, its answer decoded as `T` or its refusal thrown as `MarketRefusal`.
    /// `confirmed` is the person's Confirm it's you: the bridge sends the step once more only.
    func marketPublish<T: Decodable>(_ step: [String: Any], as type: T.Type, confirmed: Bool = false) async throws -> T {
        var payload: [String: Any] = ["type": "market.publish", "step": step]
        if confirmed { payload["confirmed"] = true }
        let reads: Set<String> = ["me", "pick", "check", "listing"]
        let changes = !reads.contains(step["step"] as? String ?? "")
        if changes, connection != "ready" {
            throw MarketRefusal(code: "offline", message: "Your machine is offline. Nothing was changed.", way: .retry, offline: true)
        }
        do {
            // A draft waits for ace's scan and a submit sends several actions: both take longer.
            let value = try await service(payload, as: ServiceValue.self, timeout: changes ? .seconds(120) : .seconds(30))
            return try marketAnswer(value, as: type)
        } catch let refusal as MarketRefusal { throw refusal }
        catch is CancellationError { throw CancellationError() }
        catch let failure as ServiceFailure where failure.transport {
            if changes {
                throw MarketRefusal(code: "unconfirmed", message: "Couldn't confirm it: your machine stopped answering. Check your listings when it's back.",
                                    way: .reread, offline: true)
            }
            throw MarketRefusal(code: "offline", message: "Your machine is offline.", way: .retry, offline: true)
        }
    }

    func marketMe() async throws -> MarketMePage {
        try await marketPublish(["step": "me"], as: MarketMePage.self)
    }
    func marketPublishables(_ type: String) async throws -> MarketPublishables {
        try await marketPublish(["step": "pick", "type": type], as: MarketPublishables.self)
    }
    func marketPublishCheck(_ item: MarketPublishable) async throws -> MarketPublishCheck {
        try await marketPublish(["step": "check", "type": item.type, "name": item.name, "pick": item.id], as: MarketPublishCheck.self)
    }
    /// Makes the draft from the check the person confirmed (by its hash), or sends a draft's files
    /// again; answers once ace's scan is done.
    func marketPublishDraft(_ item: MarketPublishable, version: String, check: MarketPublishCheck,
                            binaries: [String], routines: [Int]?, draft: String?) async throws -> MarketPublishDraft {
        var step: [String: Any] = ["step": "draft", "type": item.type, "name": item.name, "pick": item.id,
                                   "version": version, "hash": check.hash, "binaries": binaries]
        if let routines { step["routines"] = routines }
        if let draft { step["draft"] = draft }
        return try await marketPublish(step, as: MarketPublishDraftAnswer.self).draft
    }
    /// Publishes the draft with its listing and pictures (base64, at most four).
    func marketSubmit(draft: String, version: String, notes: String, listing: MarketListingWords,
                      pictures: [String], confirmed: Bool = false) async throws -> MarketPublished {
        try await marketPublish(["step": "submit", "draft": draft, "version": version, "notes": notes,
                                 "listing": listing.json, "pictures": pictures],
                                as: MarketPublishedAnswer.self, confirmed: confirmed).published
    }
    func marketManaged(type: String, name: String) async throws -> MarketManagedListing {
        try await marketPublish(["step": "listing", "type": type, "name": name], as: MarketManagedAnswer.self).listing
    }
    /// Withdraws one version, or the whole listing when `version` is nil.
    func marketWithdraw(type: String, name: String, version: String?, reason: String,
                        confirmed: Bool = false) async throws -> MarketWithdrawAnswer {
        var step: [String: Any] = ["step": "withdraw", "type": type, "name": name, "reason": reason]
        if let version { step["version"] = version }
        return try await marketPublish(step, as: MarketWithdrawAnswer.self, confirmed: confirmed)
    }
    func marketCreateProfile(handle: String, name: String, bio: String) async throws -> MarketPublisherProfile {
        try await marketPublish(["step": "createProfile", "handle": handle, "name": name, "bio": bio], as: MarketProfileAnswer.self).profile
    }
    func marketEditProfile(name: String, bio: String, links: [MarketPublisherProfile.Link],
                           confirmed: Bool = false) async throws -> MarketPublisherProfile {
        try await marketPublish(["step": "profile", "name": name, "bio": bio,
                                 "links": links.map { ["label": $0.label, "url": $0.url] }],
                                as: MarketProfileAnswer.self, confirmed: confirmed).profile
    }
    func marketChangeHandle(_ handle: String, confirmed: Bool = false) async throws -> MarketPublisherProfile {
        try await marketPublish(["step": "handle", "handle": handle], as: MarketProfileAnswer.self, confirmed: confirmed).profile
    }
    /// A new avatar, as base64 of the picture's bytes.
    func marketSetAvatar(_ image: String, confirmed: Bool = false) async throws -> MarketPublisherProfile {
        try await marketPublish(["step": "avatar", "image": image], as: MarketProfileAnswer.self, confirmed: confirmed).profile
    }
}
