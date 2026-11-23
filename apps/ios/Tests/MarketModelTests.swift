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

    @Test func suitArtworkUsesTheRequestedSchemeOrTheOnlyAvailablePalette() throws {
        let decoder = JSONDecoder()
        let both = try decoder.decode(MarketLook.self, from: Data(##"{"light":["#FBFBFC"],"dark":["#15171B"]}"##.utf8))
        #expect(both.swatches(prefersDark: false) == ["#FBFBFC"])
        #expect(both.swatches(prefersDark: true) == ["#15171B"])

        let darkOnly = try decoder.decode(MarketLook.self, from: Data(##"{"light":[],"dark":["#15171B"]}"##.utf8))
        #expect(darkOnly.swatches(prefersDark: false) == ["#15171B"])

        let missing = try decoder.decode(MarketLook.self, from: Data("{}".utf8))
        #expect(missing.swatches(prefersDark: true).isEmpty)
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

    // Browse (#2500).

    private static let discover: [String: Any] = ["type": "market.native", "operation": ["op": "discover"]]
    private static let sources: [String: Any] = ["type": "market.native", "operation": ["op": "sources"]]

    private func decode<T: Decodable>(_ value: [String: Any], as type: T.Type) throws -> T {
        try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: value))
    }

    @Test func aKeptDiscoverKeepsEachTrendingRowsPlaceAndHowItMoved() throws {
        let model = ClientModel(now: { 0 })
        var ranked = Self.listing
        ranked["rank"] = 2
        ranked["movement"] = "Up 3"
        try keep(model, Self.discover, ["ok": true, "offline": false, "hero": NSNull(), "featured": [], "trending": [ranked],
                                        "fresh": [], "collections": [], "publishers": [], "empty": false])
        let discover = try #require(model.keptMarketDiscover)
        #expect(!discover.empty)
        #expect(discover.trending.first?.rank == 2)
        #expect(discover.trending.first?.movement == "Up 3")
        #expect(discover.trending.first?.row.title == "Harbour dusk")
    }

    @Test func keptSourcesSayWhenUnreadableListingsWereReadAndWhichCanBeRemoved() throws {
        let model = ClientModel(now: { 0 })
        let git: [String: Any] = ["id": "git:abc", "kind": "git", "title": "https://example.com/c.git", "address": "https://example.com/c.git",
                                  "enabled": true, "removable": true, "entriesText": "2 entries", "listings": "Listings from 3:04 PM",
                                  "problem": "Not found."]
        try keep(model, Self.sources, ["ok": true, "offline": false, "sources": [git], "stale": "Listings from 3:04 PM"])
        let sources = try #require(model.keptMarketSources)
        #expect(sources.stale == "Listings from 3:04 PM")
        #expect(sources.sources.first?.removable == true)
        #expect(sources.sources.first?.problem == "Not found.")
    }

    @Test func aListingMadeIntoTwoBotsKeepsEachBotsCopySoRemoveTakesTheOneChosen() throws {
        func copy(_ bot: String, _ name: String, update: Bool) -> [String: Any] {
            var install = Self.waiting
            install["type"] = "spade-bot"; install["name"] = "inbox"; install["id"] = "spade-bot/inbox#\(bot)"
            install["bot"] = bot; install["update"] = update ? "2.0.0" : NSNull()
            return ["install": install, "label": name, "update": update,
                    "question": "Remove \(name)'s skills and plugins? The bot stays yours."]
        }
        var row = Self.listing
        row["action"] = ["kind": "update", "word": "Update", "reason": NSNull(),
                         "copies": [copy("bot-1", "Inbox", update: false), copy("bot-2", "Support", update: true)]]
        let action = try #require(try decode(row, as: MarketListing.self).action)
        #expect(action.copies.map(\.label) == ["Inbox", "Support"])
        #expect(action.copies.map(\.install.key) == [
            MarketInstalledKey(type: "spade-bot", name: "inbox", bot: "bot-1"),
            MarketInstalledKey(type: "spade-bot", name: "inbox", bot: "bot-2"),
        ])
        #expect(action.copies.first?.question == "Remove Inbox's skills and plugins? The bot stays yours.")
        #expect(action.updates.map(\.label) == ["Support"])
    }

    @Test func aRowWhoseInstallsAreUnknownOffersNoButton() throws {
        var row = Self.listing
        row["action"] = ["kind": "unknown", "word": NSNull(), "reason": NSNull(), "copies": []]
        let action = try #require(try decode(row, as: MarketListing.self).action)
        #expect(action.kind == "unknown")
        #expect(action.word == nil)
        #expect(action.copies.isEmpty)
    }
}
