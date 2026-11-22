import Testing
import Foundation
@testable import Ace

/// The Spade composer's strip: what it shows, what Send and the mic offer, and what a send does
/// with the picks when Spade takes or refuses the message.
@Suite struct SpadeComposerPicksTests {
    private func staged(_ name: String, _ mimeType: String) -> StagedAttachment {
        StagedAttachment(localId: UUID().uuidString.lowercased(), name: name, mimeType: mimeType, bytes: 10,
                         sha256: String(repeating: "a", count: 64))
    }

    @Test func pickedPhotosAndFilesShowInTheStripAsThePictureOrFileTheyAre() {
        var picks = SpadeComposerPicks()
        picks.add(staged("Photo.jpg", "image/jpeg"))
        picks.add(staged("brief.pdf", "application/pdf"))
        #expect(picks.strip.map(\.kind) == ["image", "file"])
        #expect(picks.strip.map(\.state) == ["ready", "ready"])
    }

    @Test func theMicShowsOnlyWhileTheFieldIsEmptyAndNothingIsAttached() {
        var picks = SpadeComposerPicks()
        #expect(picks.offersMic(""))
        #expect(!picks.offersMic("Hi"))
        picks.add(staged("Photo.jpg", "image/jpeg"))
        #expect(!picks.offersMic(""))
    }

    @Test func aPhotoAloneCanBeSentAndEmptyWordsAloneCannot() {
        var picks = SpadeComposerPicks()
        #expect(!picks.canSend("  "))
        picks.add(staged("Photo.jpg", "image/jpeg"))
        #expect(picks.canSend(""))
    }

    @Test func whileAMessageIsOutItsPicksWaitAndCantChange() throws {
        var picks = SpadeComposerPicks()
        let photo = staged("Photo.jpg", "image/jpeg")
        picks.add(photo)
        let out = try #require(picks.send(" Look "))
        #expect(out == .init(text: "Look", files: [photo], voice: nil))
        #expect(picks.strip.map(\.state) == ["uploading"])
        #expect(picks.remove(photo.localId) == nil)
        picks.add(staged("Other.png", "image/png"))
        #expect(picks.files == [photo])
        #expect(picks.send("again") == nil)
    }

    @Test func aRefusedMessageGivesItsPicksBackAndATakenOneLetsThemGo() {
        var picks = SpadeComposerPicks()
        let photo = staged("Photo.jpg", "image/jpeg")
        let voice = staged("Voice message.m4a", "audio/mp4")
        picks.add(photo)
        _ = picks.record(.init(file: voice, seconds: 4))
        _ = picks.send("")
        #expect(picks.answered(ok: false).isEmpty)
        #expect(picks.files == [photo] && picks.voice?.file == voice && !picks.sending)
        _ = picks.send("")
        #expect(picks.answered(ok: true) == [photo, voice])
        #expect(picks.isEmpty)
    }

    @Test func aNewRecordingReplacesTheLastAndDiscardRemovesIt() {
        var picks = SpadeComposerPicks()
        let first = staged("Voice message.m4a", "audio/mp4")
        let second = staged("Voice message.m4a", "audio/mp4")
        #expect(picks.record(.init(file: first, seconds: 2)) == nil)
        #expect(picks.record(.init(file: second, seconds: 3)) == first)
        #expect(picks.remove(second.localId) == second)
        #expect(picks.voice == nil)
    }

    @Test func aRecordingsLengthReadsAsMinutesAndSeconds() {
        #expect(SpadeComposerPicks.length(7.4) == "0:07")
        #expect(SpadeComposerPicks.length(65) == "1:05")
    }
}
