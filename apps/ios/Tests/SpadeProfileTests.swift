import Foundation
import Testing
@testable import Ace

/// A bot's profile on the phone: the task's Save sends once and keeps what it sent, and a list
/// that couldn't be read is told apart from one that doesn't apply.
@Suite struct SpadeProfileTests {
    @Test func aSaveOutSendsItsWordsOnceAndASecondSaveWaits() {
        var save = SpadeTaskSave()
        #expect(save.begin("  Draft and post ", task: "Draft") == "Draft and post")
        #expect(save.locked)
        // Tapped again, or typed into, while the first is out: nothing more is sent.
        #expect(save.begin("Draft, post and tweet", task: "Draft") == nil)
        #expect(save.sent == "Draft and post")
    }

    @Test func aRefusedSaveGivesTheFieldBackAndAWentSaveStaysLocked() {
        var refused = SpadeTaskSave()
        _ = refused.begin("Draft and post", task: "Draft")
        refused.refused()
        #expect(!refused.locked)
        #expect(refused.begin("Draft and post", task: "Draft") == "Draft and post")

        var went = SpadeTaskSave()
        _ = went.begin("Draft and post", task: "Draft")
        // Nothing marks it done: it stays locked until the page closes.
        #expect(went.locked)
        #expect(went.begin("Other", task: "Draft and post") == nil)
    }

    @Test func anUnchangedTaskIsNotSent() {
        var save = SpadeTaskSave()
        #expect(save.begin(" Draft\n", task: "Draft") == nil)
        #expect(!save.locked)
    }

    @Test func aLibraryTellsAboutYouThatFailedFromAboutYouThatDoesNotApply() throws {
        func library(_ about: String) throws -> SpadeProfile.Library {
            let json = """
            {"about": \(about), "notes": {"items": ["Short lines."], "more": 3},
             "pages": {"failed": true}, "files": {"items": [], "more": 0}, "skills": {"items": [], "more": 0}}
            """
            return try JSONDecoder().decode(SpadeProfile.Library.self, from: Data(json.utf8))
        }
        let spade = try library(#"{"failed": true}"#)
        #expect(spade.about?.failed == true)
        #expect(try library("null").about == nil)
        #expect(spade.notes.items == ["Short lines."] && spade.notes.more == 3 && !spade.notes.failed)
        #expect(spade.pages.failed && spade.pages.items.isEmpty)
    }

    static func profile(task: String) throws -> SpadeProfile {
        let part = #"{"items": [], "more": 0}"#
        let json = """
        {"id": "writer", "name": "Writer", "face": {"main": false, "initial": "W", "away": false},
         "details": {"task": "\(task)", "model": "Sonnet 4.5", "machine": "Studio", "routines": \(part)},
         "library": {"notes": \(part), "pages": \(part), "files": \(part), "skills": \(part)},
         "computer": {"line": "Asleep", "surfaces": [], "services": \(part)}}
        """
        return try JSONDecoder().decode(SpadeProfile.self, from: Data(json.utf8))
    }
    static func read(_ task: String) throws -> SpadeProfileAnswer {
        SpadeProfileAnswer(ok: true, profile: try profile(task: task), title: nil, message: nil)
    }

    @Test func aReadOutWhenTheTaskIsSavedCannotPutTheOldTaskBack() throws {
        var reads = SpadeProfileReads()
        let ticket1 = reads.begin()
        reads.land(try Self.read("Draft"), ticket: ticket1)
        let early = reads.begin()

        reads.saved(task: "Draft and post")
        reads.land(try Self.read("Draft"), ticket: early)

        #expect(reads.profile?.details.task == "Draft and post")
    }

    @Test func theSavedTaskShowsEvenWhenTheReadAfterTheSaveFails() throws {
        var reads = SpadeProfileReads()
        let ticket2 = reads.begin()
        reads.land(try Self.read("Draft"), ticket: ticket2)

        reads.saved(task: "Draft and post")
        let failed = SpadeProfileAnswer(ok: false, profile: nil, title: "Couldn't read the profile", message: nil)
        let ticket3 = reads.begin()
        reads.land(failed, ticket: ticket3)

        #expect(reads.profile?.details.task == "Draft and post")
        #expect(reads.problem == nil)
        // A read after the save brings Spade's own word on it.
        let ticket4 = reads.begin()
        reads.land(try Self.read("Draft and post, weekly"), ticket: ticket4)
        #expect(reads.profile?.details.task == "Draft and post, weekly")
    }
}
