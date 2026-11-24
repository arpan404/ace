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
}
