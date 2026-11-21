import Foundation
import Testing
@testable import Ace

/// Installed as `bridge/market-installed.ts` sends it: updates lead, each row says what it offers.
@MainActor @Suite struct MarketInstalledTests {
    private static let request: [String: Any] = ["type": "market.native", "operation": ["op": "installed"]]

    private static func row(_ name: String, type: String = "spade-skill", bot: Any = NSNull(), section: String,
                            update: Any = NSNull(), state: String = "on", notes: [String] = [],
                            turnOn: Any = NSNull(), updateLine: Any = NSNull()) -> [String: Any] {
        [
            "id": "\(type)/\(name)", "source": "market", "type": type, "name": name, "title": name,
            "typeWord": "Skill", "version": "1.0.0", "hash": String(repeating: "c", count: 64), "bot": bot,
            "update": update, "state": state, "waitsForBots": false, "status": "Version 1.0.0",
            "section": section, "meta": "Skill · 1.0.0", "off": state != "on", "notes": notes,
            "updateLabel": update is NSNull ? NSNull() as Any : "Update \(name)" as Any, "updateLine": updateLine,
            "rollBackTo": NSNull(), "turnOnWord": turnOn, "turnOnQuick": state == "off",
            "turnOnAsk": state == "withdrawn"
                ? ["question": "Turn \(name) back on?", "detail": "Its publisher withdrew it: Leaked headers.",
                   "confirm": "Turn back on anyway"] as Any
                : NSNull() as Any,
            "removeQuestion": "Remove \(name)?", "removeDetail": "Your bots and agents stop seeing this skill.",
        ]
    }

    private func keep(_ model: ClientModel, _ value: [String: Any]) throws -> MarketInstalledPage {
        let key = try #require(ReadMirror.key(Self.request))
        let frame = try JSONSerialization.data(withJSONObject: [["type": "service.cache", "key": key, "family": "market", "value": value]])
        model.receive(frame)
        return try #require(model.keptMarket(["op": "installed"], as: MarketInstalledPage.self))
    }

    @Test func twoWaitingUpdatesLeadAndTheRestFollow() throws {
        let page = try keep(ClientModel(now: { 0 }), [
            "ok": true, "offline": false, "updates": 2, "updatesText": "2 updates", "updatesTitle": "2 updates",
            "upToDate": NSNull(), "empty": NSNull(),
            "rows": [
                Self.row("beta", section: "updates", update: "2.0.0"),
                Self.row("inbox", type: "spade-bot", bot: "bot-1", section: "updates", update: "1.1.0",
                         updateLine: "Only inbox moves to 1.1.0."),
                Self.row("alpha", section: "installed"),
            ],
        ])
        #expect(page.waiting.map(\.install.name) == ["beta", "inbox"])
        #expect(page.rest.map(\.install.name) == ["alpha"])
        let bot = try #require(page.waiting.last)
        #expect(bot.install.key == MarketInstalledKey(type: "spade-bot", name: "inbox", bot: "bot-1"))
        #expect(bot.updateLine == "Only inbox moves to 1.1.0.")
    }

    @Test func aWithdrawnRowReadsOffWithItsReasonAndCanComeBack() throws {
        let page = try keep(ClientModel(now: { 0 }), [
            "ok": true, "offline": true, "updates": 0, "updatesText": NSNull(), "updatesTitle": "No updates",
            "upToDate": "Everything is up to date. ace checks once a day.", "empty": NSNull(),
            "rows": [Self.row("digest", section: "installed", state: "withdrawn",
                              notes: ["Off · Withdrawn by its publisher: Leaked headers."], turnOn: "Turn back on")],
        ])
        let row = try #require(page.rest.first)
        #expect(page.offline)
        #expect(row.off)
        #expect(row.notes.first == "Off · Withdrawn by its publisher: Leaked headers.")
        #expect(row.turnOnWord == "Turn back on")
        // A withdrawn entry never comes back in one swipe: only through its question.
        #expect(!row.turnOnQuick)
        #expect(row.turnOnAsk?.confirm == "Turn back on anyway")
        #expect(row.turnOnAsk?.detail == "Its publisher withdrew it: Leaked headers.")
        #expect(row.updateLabel == nil)
    }
}
