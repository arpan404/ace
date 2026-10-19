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

    /// A machine's connection may read its own device token and nothing else.
    static func connection(_ target: ConnectionTarget) -> HostServices {
        var services = HostServices()
        if let key = target.secretKey { services.secretAccess = .read(key) }
        return services
    }

    /// Secret, directory and result operations. Returns nil for operations owned elsewhere.
    func perform(_ operation: String, input: Data) throws -> String? {
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
            let value = try JSONDecoder().decode(String.self, from: input)
            guard value.utf8.count <= 1_048_576 else { throw HostError.storage }
            try FileManager.default.createDirectory(at: directoryURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(value.utf8).write(to: directoryURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            return ""
        case "attachment.chunk":
            let read = try JSONDecoder().decode(ChunkRead.self, from: input)
            let staging = attachments.holds(read.localId) ? attachments : draftAttachments
            return try staging.chunk(read.localId, offset: read.offset, limit: read.limit)
        case "access.result":
            guard let result else { throw HostError.unsupported }
            result(String(decoding: input, as: UTF8.self))
            return ""
        default: return nil
        }
    }
}
private struct SecretWrite: Decodable { let key: String; let token: String }
private struct ChunkRead: Decodable { let localId: String; let offset: Int; let limit: Int }
