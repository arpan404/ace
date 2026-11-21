import Foundation
import Testing
@testable import Ace

/// Settings › Spade on the phone: a page as the bridge answers it, and how its reads and
/// changes land, so a refusal never blanks the page and a late read never undoes a change.
@Suite struct SpadeSettingsTests {
    private func answer(_ json: String) throws -> SpadeSettings.Answer {
        try JSONDecoder().decode(SpadeSettings.Answer.self, from: Data(json.utf8))
    }
    private let line = #"{"sentence": "", "ready": true, "canTurnOn": false}"#

    private func models(key: String) throws -> SpadeSettings.Answer {
        try answer("""
        {"ok": true, "line": \(line), "models": {"endpoints": [{"id": "openrouter", "name": "OpenRouter",
          "address": "openrouter.ai", "key": {"words": "\(key)", "set": false, "canSet": true, "canRemove": false},
          "models": ["Kimi K2"], "more": 0}], "presets": [], "keychain": true, "note": "Keys stay here."}}
        """)
    }

    @Test func aRefusedChangeSaysWhyAndKeepsThePageAsItWas() throws {
        var reads = SpadeSettingsReads()
        reads.land(try models(key: "Not set"), ticket: reads.begin())

        let ticket = reads.begin()
        reads.changed(.failed("Couldn't keep the key", "The keychain refused the key."), ticket: ticket)

        #expect(reads.refusal == "Couldn't keep the key. The keychain refused the key.")
        #expect(reads.answer?.models?.endpoints.first?.key.words == "Not set")
    }

    @Test func aReadThatLandsAfterAChangeBeganIsDropped() throws {
        var reads = SpadeSettingsReads()
        let read = reads.begin()
        let change = reads.begin()
        reads.changed(try models(key: "In keychain"), ticket: change)
        // The read began before the change: what it says is older.
        reads.land(try models(key: "Not set"), ticket: read)

        #expect(reads.answer?.models?.endpoints.first?.key.words == "In keychain")
        #expect(reads.refusal == nil)
    }

    @Test func aFailedReadSaysSoOnlyWhileThereIsNoPage() throws {
        var empty = SpadeSettingsReads()
        empty.land(.failed("Couldn't read Spade's settings", "Spade answered 500."), ticket: empty.begin())
        #expect(empty.problem == "Couldn't read Spade's settings. Spade answered 500.")

        var shown = SpadeSettingsReads()
        shown.land(try models(key: "Not set"), ticket: shown.begin())
        shown.land(.failed("Couldn't read Spade's settings", nil), ticket: shown.begin())
        #expect(shown.problem == nil)
        #expect(shown.answer != nil)
    }

    @Test func aPageSpadeCannotAnswerCarriesOnlyItsState() throws {
        let off = try answer(#"{"ok": true, "line": {"sentence": "Spade is off.", "ready": false, "canTurnOn": true}}"#)
        #expect(off.line?.canTurnOn == true)
        #expect(off.models == nil && off.general == nil)
    }

    @Test func aWriteThatWentThroughWithoutItsPageKeepsThePageAndSaysSo() throws {
        var reads = SpadeSettingsReads()
        reads.land(try models(key: "Not set"), ticket: reads.begin())

        let saved = try answer(#"{"ok": true, "line": {"sentence": "", "ready": true, "canTurnOn": false}, "notice": "Saved. The page couldn't be read again; pull to refresh."}"#)
        reads.changed(saved, ticket: reads.begin())

        #expect(reads.notice == "Saved. The page couldn't be read again; pull to refresh.")
        #expect(reads.answer?.models?.endpoints.first?.key.words == "Not set")
        #expect(reads.refusal == nil)
    }

    @MainActor @Test func overlappingWritesRunInTurnAndARefreshAskedMeanwhileWaitsForThem() async throws {
        let log = Log()
        let page = try models(key: "Not set")
        let load = SpadeSettingsLoad(page: .models) {
            log.items.append("read")
            return page
        }
        let (gate, open) = AsyncStream<Void>.makeStream()
        let kept = try models(key: "In keychain")
        let first = Task {
            await load.awaiting {
                log.items.append("write 1")
                for await _ in gate { break }
                log.items.append("write 1 done")
                return kept
            }
        }
        while !log.items.contains("write 1") { await Task.yield() }
        let second = Task {
            await load.awaiting {
                log.items.append("write 2")
                return kept
            }
        }
        for _ in 0..<20 { await Task.yield() }
        // A pull while both are out: it waits for them, so it can't undo what they confirm.
        await load.load()
        #expect(log.items == ["write 1"])

        open.yield(())
        _ = await first.value
        _ = await second.value
        while log.items.count < 4 { await Task.yield() }

        #expect(log.items == ["write 1", "write 1 done", "write 2", "read"])
        #expect(!load.busy)
    }
}

/// New bot: a bot that was made but whose first message didn't go is never made twice.
@Suite struct SpadeNewBotProgressTests {
    private func answer(_ json: String) throws -> SpadeNewBotAnswer {
        try JSONDecoder().decode(SpadeNewBotAnswer.self, from: Data(json.utf8))
    }

    @Test func aMadeBotWhoseFirstMessageFailedIsSentToAgainNotMadeAgain() throws {
        var progress = SpadeNewBotProgress()
        #expect(progress.next == .create)

        let half = try answer(#"{"ok": false, "title": "It's made, but its first message didn't send", "message": "busy", "agentId": "a1", "conversation": "c1"}"#)
        #expect(progress.land(half) == nil)
        #expect(progress.next == .send(conversation: "c1"))
        #expect(progress.problem == "It's made, but its first message didn't send. busy")

        #expect(progress.sent(SpadeOutcome(ok: false, title: "Couldn't send", message: "busy"), to: "c1") == nil)
        #expect(progress.next == .send(conversation: "c1"))
        #expect(progress.sent(SpadeOutcome(ok: true), to: "c1") == "c1")
    }

    @Test func aBotSpadeWouldNotMakeIsMadeAgainOnTheNextTry() throws {
        var progress = SpadeNewBotProgress()
        #expect(progress.land(try answer(#"{"ok": false, "title": "Couldn't make the bot", "message": "Add a model first."}"#)) == nil)
        #expect(progress.next == .create)
        #expect(progress.land(try answer(#"{"ok": true, "agentId": "a1", "conversation": "c1"}"#)) == "c1")
    }
}

@MainActor private final class Log {
    var items: [String] = []
}
