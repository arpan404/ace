import Testing
@testable import Ace

@Suite struct AttachmentUploadsTests {
    private func file(_ id: String, _ state: String) -> AttachmentFile {
        AttachmentFile(id: id, name: "\(id).png", kind: "image", bytes: 1024, state: state, progress: 0.5, error: "")
    }

    @Test func sendWaitsWhileAFileUploadsAndSaysSo() {
        let files = [file("a", "ready"), file("b", "uploading"), file("c", "uploading")]
        #expect(AttachmentUploads.holdsSend(files))
        #expect(AttachmentUploads.line(files) == "Files uploading")
    }

    @Test func aFailedFileHoldsSendUntilItIsRetriedOrRemoved() {
        let files = [file("a", "failed"), file("b", "uploading")]
        #expect(AttachmentUploads.line(files) == "1 file didn't upload. Retry or remove it to send.")
    }

    @Test func filesAllOnLetTheMessageGo() {
        #expect(!AttachmentUploads.holdsSend([file("a", "ready")]))
        #expect(!AttachmentUploads.holdsSend([]))
        #expect(AttachmentUploads.line([file("a", "ready")]) == nil)
    }
}
