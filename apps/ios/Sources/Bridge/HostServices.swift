import Foundation

/// Native capabilities a runtime may use beyond its socket and outbox database.
struct HostServices: Sendable {
    var secrets: any SecretStore = KeychainSecrets()
    var secretAccess: SecretAccess = .none
    /// Non-secret machine directory written by `@ace/client/machines`; nil outside access runtimes.
    var directoryURL: URL?
    /// Receives an access runtime's single result.
    var result: (@Sendable (String) -> Void)?
    var now: @Sendable () -> Date = { Date() }
    /// Photos and files staged for the next message (`AttachmentStaging`).
    var attachments = AttachmentStaging()
    /// New thread's first-message files, kept with its draft across launches.
    var draftAttachments = NewThreadDraftStore.standard().files
    /// Browser downloads copied onto the phone.
    var saved = SavedFiles()

    /// A machine's connection may read its own device token and nothing else.
    static func connection(_ target: ConnectionTarget) -> HostServices {
        var services = HostServices()
        if let key = target.secretKey { services.secretAccess = .read(key) }
        // Saved downloads are this machine's: another machine's same ids are other files.
        services.saved.scope = target.hostId
        return services
    }

    /// Secret, directory and result operations. Returns nil for operations owned elsewhere.
    func perform(_ request: HostRequest) throws -> String? {
        let operation = request.operation, input = request.input
        switch operation {
        case "secret.get", "secret.delete":
            let key = try JSONDecoder().decode(String.self, from: input)
            guard secretAccess.permits(operation, key: key) else { throw HostError.unsupported }
            if operation == "secret.get" { return try secrets.get(key) ?? "" }
            try secrets.delete(key)
            return ""
        case "secret.set":
            let value = try JSONDecoder().decode(SecretWrite.self, from: input)
            guard secretAccess.permits(operation, key: value.key), PinnedTrust.isPin(value.token) else { throw HostError.unsupported }
            try secrets.set(value.key, value.token)
            return ""
        case "directory.load":
            guard let directoryURL else { throw HostError.unsupported }
            guard FileManager.default.fileExists(atPath: directoryURL.path) else { return "" }
            return try String(contentsOf: directoryURL, encoding: .utf8)
        case "directory.save":
            guard let directoryURL else { throw HostError.unsupported }
            let value = try request.requireBody()
            guard value.utf8.count <= 1_048_576 else { throw HostError.storage }
            try FileManager.default.createDirectory(at: directoryURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(value.utf8).write(to: directoryURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            return ""
        case "attachment.chunk":
            let read = try JSONDecoder().decode(ChunkRead.self, from: input)
            let staging = attachments.holds(read.localId) ? attachments : draftAttachments
            return try staging.chunk(read.localId, offset: read.offset, limit: read.limit)
        case "file.write":
            let write = try JSONDecoder().decode(FileWrite.self, from: input)
            try saved.write(id: write.id, name: write.name, offset: write.offset, base64: try request.requireBody(), done: write.done)
            return ""
        case "file.discard":
            saved.discard(id: try JSONDecoder().decode(FileDiscard.self, from: input).id)
            return ""
        case "capture.stage":
            // An annotation's crop or page screenshot, staged as a message file like a photo.
            let capture = try JSONDecoder().decode(CaptureStage.self, from: input)
            guard capture.mimeType == "image/png" || capture.mimeType == "image/jpeg",
                  let data = Data(base64Encoded: try request.requireBody()) else { throw HostError.unsupported }
            let staged = try attachments.stage(data: data, name: capture.name, mimeType: capture.mimeType)
            return String(decoding: try JSONSerialization.data(withJSONObject: staged.json), as: UTF8.self)
        case "access.result":
            guard let result else { throw HostError.unsupported }
            result(try request.requireBody())
            return ""
        default: return nil
        }
    }
}
private struct SecretWrite: Decodable { let key: String; let token: String }
private struct ChunkRead: Decodable { let localId: String; let offset: Int; let limit: Int }
private struct FileWrite: Decodable { let id: String; let name: String; let offset: Int; let done: Bool }
private struct FileDiscard: Decodable { let id: String }
private struct CaptureStage: Decodable { let name: String; let mimeType: String }
