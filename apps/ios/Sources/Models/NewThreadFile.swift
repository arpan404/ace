import Foundation

/// A file picked for New thread's first message, as the draft keeps it: what the bridge needs to
/// check and upload it again after a relaunch, and the project it was picked for. The bytes stay
/// in the draft's own staging folder under `localId`.
struct NewThreadFile: Codable, Equatable, Sendable {
    let localId: String
    let name: String
    let mimeType: String
    let bytes: Int
    let sha256: String
    let workspaceId: String

    init(_ file: StagedAttachment, workspaceId: String) {
        localId = file.localId; name = file.name; mimeType = file.mimeType; bytes = file.bytes; sha256 = file.sha256
        self.workspaceId = workspaceId
    }
    var staged: StagedAttachment { StagedAttachment(localId: localId, name: name, mimeType: mimeType, bytes: bytes, sha256: sha256) }
}

extension NewThreadDraft {
    private enum Key: String, CodingKey {
        case machineId, projectId, provider, model, account, effort, speed, access, worktree, base, text, commandId, files
    }
    /// Lenient: a draft saved by an older build (before files) or with one unreadable field still
    /// loads with everything else the person chose.
    init(from decoder: any Decoder) throws {
        self.init()
        let box = try decoder.container(keyedBy: Key.self)
        machineId = try? box.decodeIfPresent(String.self, forKey: .machineId)
        projectId = try? box.decodeIfPresent(String.self, forKey: .projectId)
        provider = try? box.decodeIfPresent(String.self, forKey: .provider)
        model = try? box.decodeIfPresent(String.self, forKey: .model)
        account = try? box.decodeIfPresent(String.self, forKey: .account)
        effort = try? box.decodeIfPresent(String.self, forKey: .effort)
        speed = try? box.decodeIfPresent(String.self, forKey: .speed)
        access = try? box.decodeIfPresent(String.self, forKey: .access)
        worktree = (try? box.decodeIfPresent(Bool.self, forKey: .worktree)) ?? false
        base = try? box.decodeIfPresent(ComposeBaseRef.self, forKey: .base)
        text = (try? box.decodeIfPresent(String.self, forKey: .text)) ?? ""
        commandId = try? box.decodeIfPresent(String.self, forKey: .commandId)
        files = (try? box.decodeIfPresent([NewThreadFile].self, forKey: .files)) ?? []
    }
}
