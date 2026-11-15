import Testing
@testable import Ace

@Suite struct PasteIntakeTests {
    private func file(_ id: String) -> StagedAttachment {
        StagedAttachment(localId: id, name: "Pasted 60 lines.txt", mimeType: "text/plain", bytes: 10, sha256: id)
    }

    @Test func aPasteHoldsSendInItsThreadUntilItIsStaged() {
        var intake = PasteIntake()
        let ticket = intake.began(scope: "A", name: "Pasted 60 lines.txt")
        #expect(intake.holdsSend(in: "A"))
        #expect(!intake.holdsSend(in: "B"))
        #expect(intake.adding(in: "A").map(\.name) == ["Pasted 60 lines.txt"])
        let done = intake.finished(ticket, file: file("a"), open: "A")
        #expect(done.attach == [file("a")])
        #expect(!intake.holdsSend(in: "A"))
        #expect(intake.adding(in: "A").isEmpty)
    }
    @Test func pastesAttachInTheOrderTheyWerePastedWhicheverFinishesFirst() {
        var intake = PasteIntake()
        let first = intake.began(scope: "A", name: "Pasted 60 lines.txt")
        let second = intake.began(scope: "A", name: "Pasted 90 lines.txt")
        // The second finishes first: it waits for the first.
        let early = intake.finished(second, file: file("b"), open: "A")
        #expect(early.attach.isEmpty && early.discard.isEmpty)
        #expect(intake.holdsSend(in: "A"))
        let late = intake.finished(first, file: file("a"), open: "A")
        #expect(late.attach == [file("a"), file("b")])
        #expect(!intake.holdsSend(in: "A"))
    }
    @Test func aPasteWhoseThreadClosedMeanwhileIsDiscardedNotAttachedElsewhere() {
        var intake = PasteIntake()
        let ticket = intake.began(scope: "A", name: "Pasted 60 lines.txt")
        // The person opened thread B while A's paste was being written.
        let done = intake.finished(ticket, file: file("a"), open: "B")
        #expect(done.attach.isEmpty)
        #expect(done.discard == [file("a")])
        #expect(!intake.holdsSend(in: "A"))
    }
    @Test func aPasteWaitingOnAnEarlierOneIsDiscardedIfItsThreadClosesFirst() {
        var intake = PasteIntake()
        let first = intake.began(scope: "A", name: "one")
        let second = intake.began(scope: "A", name: "two")
        _ = intake.finished(second, file: file("b"), open: "A")
        let done = intake.finished(first, file: file("a"), open: "B")
        #expect(done.attach.isEmpty)
        #expect(Set(done.discard.map(\.localId)) == ["a", "b"])
    }
    @Test func aPasteThatFailedStepsAsideAndTheNextOneGoes() {
        var intake = PasteIntake()
        let first = intake.began(scope: "A", name: "one")
        let second = intake.began(scope: "A", name: "two")
        _ = intake.finished(second, file: file("b"), open: "A")
        let done = intake.finished(first, file: nil, open: "A")
        #expect(done.attach == [file("b")])
        #expect(!intake.holdsSend(in: "A"))
    }
    @Test func pastesInOneThreadNeverHoldAnother() {
        var intake = PasteIntake()
        let a = intake.began(scope: "A", name: "one")
        let b = intake.began(scope: "B", name: "two")
        // B's paste needn't wait for A's: each thread keeps its own order.
        #expect(intake.finished(b, file: file("b"), open: "B").attach == [file("b")])
        #expect(intake.holdsSend(in: "A"))
        _ = intake.finished(a, file: file("a"), open: "B")
        #expect(!intake.holdsSend(in: "A"))
    }
}
