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
    private let pdfCopy = URL(fileURLWithPath: "/tmp/notes.pdf")

    private func clip(_ name: String) -> AttachmentLine { line(name, mime: "video/mp4", kind: "video") }
    private var notes: AttachmentLine { line("notes.pdf", mime: "application/pdf", kind: "pdf") }

    @Test func openingTheSecondClipGivesThePlayerThatClip() {
        var state = AttachmentOpenState()
        let one = state.begin(name: "one.mp4")
        let two = state.begin(name: "two.mp4")
        let lateOne = state.complete(one, kept: first, line: clip("one.mp4"), replyMimeType: "video/mp4")
        let removed = state.complete(two, kept: second, line: clip("two.mp4"), replyMimeType: "video/mp4")
        #expect(lateOne == [first])
        #expect(removed.isEmpty)
        #expect(state.visible == .video(MessageVideoTarget(name: "two.mp4", url: second, mimeType: "video/mp4")))
    }

    @Test func aDocumentRoutesToQuickLookAndAVideoToThePlayer() {
        var state = AttachmentOpenState()
        let token = state.begin(name: "notes.pdf")
        _ = state.complete(token, kept: pdfCopy, line: notes, replyMimeType: "application/pdf")
        #expect(state.visible == .document(pdfCopy))
    }

    @Test func aPictureTapSupersedesAPendingOpen() {
        var state = AttachmentOpenState()
        let token = state.begin(name: "notes.pdf")
        let target = AttachmentTarget(itemId: "m1", pictures: [line("a.png", mime: "image/png", kind: "image", thumbnail: true)], start: 0)
        _ = state.showImages(target)
        let removed = state.complete(token, kept: pdfCopy, line: notes, replyMimeType: "application/pdf")
        #expect(removed == [pdfCopy])
        #expect(state.visible == .images(target))
    }

    @Test func aReplacementWaitsForTheOutgoingViewerAndALateDismissalCannotTouchIt() {
        var state = AttachmentOpenState()
        let video = state.begin(name: "one.mp4")
        _ = state.complete(video, kept: first, line: clip("one.mp4"), replyMimeType: "video/mp4")
        let videoViewer = state.shown?.id ?? -1
        let pdf = state.begin(name: "notes.pdf")
        _ = state.complete(pdf, kept: pdfCopy, line: notes, replyMimeType: "application/pdf")
        #expect(state.visible == nil)
        #expect(state.queued == .document(pdfCopy))
        let afterVideo = state.dismissed(videoViewer)
        #expect(afterVideo == [first])
        #expect(state.visible == .document(pdfCopy))
        let stale = state.dismissed(videoViewer)
        #expect(stale.isEmpty)
        #expect(state.visible == .document(pdfCopy))
    }

    @Test func aNewerReplacementRemovesTheOneItDisplaced() {
        var state = AttachmentOpenState()
        let video = state.begin(name: "one.mp4")
        _ = state.complete(video, kept: first, line: clip("one.mp4"), replyMimeType: "video/mp4")
        let pdf = state.begin(name: "notes.pdf")
        _ = state.complete(pdf, kept: pdfCopy, line: notes, replyMimeType: "application/pdf")
        let next = state.begin(name: "two.mp4")
        let removed = state.complete(next, kept: second, line: clip("two.mp4"), replyMimeType: "video/mp4")
        #expect(removed == [pdfCopy])
        #expect(state.queued == .video(MessageVideoTarget(name: "two.mp4", url: second, mimeType: "video/mp4")))
    }

    @Test func leavingTheRouteStopsPendingOpensAndDropsAWaitingReplacement() {
        var state = AttachmentOpenState()
        let video = state.begin(name: "one.mp4")
        _ = state.complete(video, kept: first, line: clip("one.mp4"), replyMimeType: "video/mp4")
        let pdf = state.begin(name: "notes.pdf")
        _ = state.complete(pdf, kept: pdfCopy, line: notes, replyMimeType: "application/pdf")
        let late = state.begin(name: "two.mp4")
        let dropped = state.leave()
        let removed = state.complete(late, kept: second, line: clip("two.mp4"), replyMimeType: "video/mp4")
        #expect(dropped == [pdfCopy])
        #expect(removed == [second])
        #expect(state.pending == nil)
    }

    @Test func aCopyBeingSharedIsKeptUntilTheShareEnds() {
        var state = AttachmentOpenState()
        let token = state.begin(name: "one.mp4")
        _ = state.complete(token, kept: first, line: clip("one.mp4"), replyMimeType: "video/mp4")
        let viewer = state.shown?.id ?? -1
        _ = state.shareChanged(true)
        let during = state.dismissed(viewer)
        let after = state.shareChanged(false)
        #expect(during.isEmpty)
        #expect(after == [first])
    }

    @Test func closingThePlayerHandsBackItsCopyToRemove() {
        var state = AttachmentOpenState()
        let token = state.begin(name: "one.mp4")
        _ = state.complete(token, kept: first, line: clip("one.mp4"), replyMimeType: "video/mp4")
        let viewer = state.shown?.id ?? -1
        let owned = state.dismissed(viewer)
        #expect(owned == [first])
        #expect(state.shown == nil)
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

    @Test func anM4vSentAsGenericBinaryPlaysInTheApp() {
        let generic = line("Holiday.M4V", mime: "application/octet-stream", kind: "binary")
        #expect(generic.plays)
        #expect(generic.route(replyMimeType: "application/octet-stream") == .video(name: "Holiday.M4V", mimeType: "video/x-m4v"))
        #expect(AttachmentLayout([generic]).videos == [generic])
        let report = line("report.bin", mime: "application/octet-stream", kind: "binary")
        #expect(!report.plays)
    }

    @Test func anM4vNamedFileWithAnExplicitNonVideoTypeStaysADocument() {
        let archive = line("archive.m4v", mime: "application/zip", kind: "file")
        #expect(!archive.plays)
        #expect(archive.route(replyMimeType: "application/zip") == .document)
    }
}
