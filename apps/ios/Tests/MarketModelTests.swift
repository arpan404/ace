import Foundation
import Testing
@testable import Ace

/// The marketplace's answers as `bridge/market.ts` sends them, drawn by the phone.
@MainActor @Suite struct MarketModelTests {
    private static let home: [String: Any] = ["type": "market.native", "operation": ["op": "home"]]
    private static let installed: [String: Any] = ["type": "market.native", "operation": ["op": "installed"]]
    private static let listing: [String: Any] = [
        "id": "market/suit/harbour-dusk", "source": "market", "type": "suit", "name": "harbour-dusk",
        "title": "Harbour dusk", "line": "A dusk look", "typeWord": "Suit", "publisher": NSNull(),
        "verified": false, "byAce": true, "reviewed": true, "supported": true, "version": "1.0.0",
        "picture": NSNull(), "block": NSNull(),
    ]
    private static let waiting: [String: Any] = [
        "id": "spade-skill/triage", "source": "market", "type": "spade-skill", "name": "triage", "title": "Triage",
        "typeWord": "Skill", "version": "1.0.0", "hash": String(repeating: "c", count: 64), "bot": NSNull(),
        "update": NSNull(), "state": "on", "waitsForBots": true, "status": "Installed · Turn on for your bots",
    ]

    private func keep(_ model: ClientModel, _ request: [String: Any], _ value: [String: Any]) throws {
        let key = try #require(ReadMirror.key(request))
        let frame = try JSONSerialization.data(withJSONObject: [["type": "service.cache", "key": key, "family": "market", "value": value]])
        model.receive(frame)
    }

    @Test func theKeptHomeGivesTheMarketplaceItsUpdatesWord() throws {
        let model = ClientModel(now: { 0 })
        #expect(model.keptMarketHome == nil)
        try keep(model, Self.home, ["ok": true, "offline": false, "featured": [Self.listing],
                                    "categories": [["id": "mail", "title": "Mail", "countText": "2 entries"]],
                                    "installed": 3, "updates": 2, "updatesText": "2 updates"])
        let home = try #require(model.keptMarketHome)
        #expect(home.updatesText == "2 updates")
        #expect(home.featured.first?.key == MarketEntryKey(source: "market", type: "suit", name: "harbour-dusk"))
    }

    @Test func aSkillWaitingForThePersonKeepsItsHashAndSaysSo() throws {
        let model = ClientModel(now: { 0 })
        try keep(model, Self.installed, ["ok": true, "offline": false, "rows": [Self.waiting], "updates": 0, "updatesText": NSNull()])
        let row = try #require(model.keptMarketInstalled?.rows.first)
        #expect(row.waitsForBots)
        #expect(row.status == "Installed · Turn on for your bots")
        #expect(row.key == MarketInstalledKey(type: "spade-skill", name: "triage", bot: nil))
    }
}
