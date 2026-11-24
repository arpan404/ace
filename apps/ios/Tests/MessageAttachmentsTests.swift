import Foundation
import Testing
@testable import Ace

struct MessageAttachmentsTests {
    private func line(_ name: String, mime: String, kind: String = "file", thumbnail: Bool? = nil, opens: Bool? = true) -> AttachmentLine {
        AttachmentLine(kind: kind, name: name, ref: "ref-\(name)", mimeType: mime, bytes: 1_000, thumbnail: thumbnail, opens: opens)
    }

    @Test func aVideoThatOpensDrawsAsAVideoTileNotAFileRow() {
        let video = line("Video.mp4", mime: "video/mp4")
        let layout = AttachmentLayout([video])
        #expect(layout.videos == [video])
        #expect(layout.files.isEmpty)
    }

    @Test func aVideoTheMachineCantOpenStaysAFileRow() {
        let video = line("Video.mp4", mime: "video/mp4", opens: false)
        let layout = AttachmentLayout([video])
        #expect(layout.videos.isEmpty)
        #expect(layout.files == [video])
    }

    @Test func picturesVideosAndFilesKeepTheirOrderWithinEachGroup() {
        let picture = line("a.png", mime: "image/png", kind: "image", thumbnail: true)
        let first = line("one.mov", mime: "video/quicktime")
        let notes = line("notes.pdf", mime: "application/pdf", kind: "pdf")
        let second = line("two.mp4", mime: "video/mp4", kind: "video")
        let layout = AttachmentLayout([first, picture, notes, second])
        #expect(layout.images == [picture])
        #expect(layout.videos == [first, second])
        #expect(layout.files == [notes])
    }

    private let first = URL(fileURLWithPath: "/tmp/one.mp4")
    private let second = URL(fileURLWithPath: "/tmp/two.mp4")

    @Test func openingTheSecondClipGivesThePlayerThatClip() {
        var state = AttachmentOpenState()
        let one = state.begin(name: "one.mp4")
        let two = state.begin(name: "two.mp4")
        let lateOne = state.complete(one, kept: first, as: .video(name: "one.mp4", mimeType: "video/mp4"))
        #expect(lateOne == nil)
        let shown = state.complete(two, kept: second, as: .video(name: "two.mp4", mimeType: "video/mp4"))
        #expect(shown?.url == second)
        #expect(state.presentation == shown)
    }

    @Test func aDocumentOpenedAfterAVideoIsTheOnlyThingPresented() {
        var state = AttachmentOpenState()
        let video = state.begin(name: "clip.mp4")
        let pdf = state.begin(name: "notes.pdf")
        let shownPDF = state.complete(pdf, kept: second, as: .document)
        let lateVideo = state.complete(video, kept: first, as: .video(name: "clip.mp4", mimeType: "video/mp4"))
        #expect(shownPDF == .document(second))
        #expect(lateVideo == nil)
        #expect(state.presentation == .document(second))
    }

    @Test func aSupersededOpenThatFailsStaysQuiet() {
        var state = AttachmentOpenState()
        let old = state.begin(name: "old.mp4")
        let latest = state.begin(name: "new.mp4")
        let oldFailed = state.fail(old)
        #expect(!oldFailed)
        #expect(state.pending?.token == latest)
        let latestFailed = state.fail(latest)
        #expect(latestFailed)
        #expect(state.pending == nil)
    }

    @Test func closingThePlayerHandsBackItsCopyToRemove() {
        var state = AttachmentOpenState()
        let token = state.begin(name: "one.mp4")
        _ = state.complete(token, kept: first, as: .video(name: "one.mp4", mimeType: "video/mp4"))
        let owned = state.close()
        #expect(owned == first)
        #expect(state.presentation == nil)
        let again = state.close()
        #expect(again == nil)
    }

    @Test func anM4vSentAsGenericBinaryPlaysInTheApp() {
        let clip = line("Holiday.M4V", mime: "application/octet-stream", kind: "binary")
        #expect(clip.plays)
        #expect(AttachmentLayout([clip]).videos == [clip])
        let report = line("report.bin", mime: "application/octet-stream", kind: "binary")
        #expect(!report.plays)
    }
}
