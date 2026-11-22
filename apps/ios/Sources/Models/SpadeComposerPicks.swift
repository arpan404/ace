import Foundation

/// What the Spade composer holds besides its words: the photos and files picked for the next
/// message and one voice recording, staged on the phone (`AttachmentStaging`). While a message is
/// out they wait, greyed, and can't change; Spade's answer either lets them go or gives them back
/// with why, so nothing is half-sent. Spade's limits are the bridge's to check.
struct SpadeComposerPicks: Equatable, Sendable {
    /// A recording and how long it runs.
    struct Recording: Equatable, Sendable {
        let file: StagedAttachment
        let seconds: Double
    }
    /// What one send carries, taken from the picks when it went.
    struct Outgoing: Equatable, Sendable {
        let text: String
        let files: [StagedAttachment]
        let voice: StagedAttachment?
    }

    private(set) var files: [StagedAttachment] = []
    private(set) var voice: Recording?
    /// A message carrying them is out.
    private(set) var sending = false

    var isEmpty: Bool { files.isEmpty && voice == nil }

    /// A picked photo or file joins the message; nothing changes while one is out.
    mutating func add(_ file: StagedAttachment) {
        guard !sending, !files.contains(where: { $0.localId == file.localId }) else { return }
        files.append(file)
    }
    /// The recording for the message, replacing any before it; the one it replaced, to discard.
    mutating func record(_ recording: Recording) -> StagedAttachment? {
        guard !sending else { return recording.file }
        let old = voice?.file
        voice = recording
        return old
    }
    /// Takes a file or the recording off the message; what was removed, to discard.
    mutating func remove(_ localId: String) -> StagedAttachment? {
        guard !sending else { return nil }
        if voice?.file.localId == localId {
            defer { voice = nil }
            return voice?.file
        }
        guard let index = files.firstIndex(where: { $0.localId == localId }) else { return nil }
        return files.remove(at: index)
    }

    /// Whether Send can go: some words, or something attached, and nothing already out.
    func canSend(_ text: String) -> Bool {
        !sending && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !isEmpty)
    }
    /// Whether the mic shows in Send's place: an empty field, nothing on the message, nothing out.
    func offersMic(_ text: String) -> Bool {
        !sending && isEmpty && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The message to send with `text`, and the picks held until Spade answers; nil when there is
    /// nothing to send.
    mutating func send(_ text: String) -> Outgoing? {
        guard canSend(text) else { return nil }
        sending = true
        return Outgoing(text: text.trimmingCharacters(in: .whitespacesAndNewlines), files: files, voice: voice?.file)
    }
    /// Spade's answer: taken, the picks go and are returned to discard; refused, they come back.
    mutating func answered(ok: Bool) -> [StagedAttachment] {
        sending = false
        guard ok else { return [] }
        let gone = files + (voice.map { [$0.file] } ?? [])
        files = []
        voice = nil
        return gone
    }

    /// The strip's rows, as the thread composer's tray draws them (`ComposerMediaStrip`): each
    /// waiting while a message is out.
    var strip: [AttachmentFile] {
        files.map { file in
            AttachmentFile(id: file.localId, name: file.name, kind: Self.kind(file.mimeType), bytes: file.bytes,
                           state: sending ? "uploading" : "ready", progress: 0, error: "", mimeType: file.mimeType)
        }
    }
    private static func kind(_ mimeType: String) -> String {
        if mimeType.hasPrefix("image/") { return "image" }
        if mimeType.hasPrefix("video/") { return "video" }
        return "file"
    }

    /// "0:07": a recording's length, as the strip and a voice message say it.
    static func length(_ seconds: Double) -> String {
        let whole = max(0, Int(seconds.rounded()))
        return "\(whole / 60):\(String(format: "%02d", whole % 60))"
    }
}
