import Foundation

/// A project as the machine lists it. `raw` is the whole record, sent back unchanged when the
/// person saves an edit, so fields this phone doesn't know about are never lost.
struct NativeProject: Decodable, Identifiable, Sendable {
    struct Badge: Decodable, Sendable { let color: String?; let glyph: String? }
    struct Note: Decodable, Sendable, Identifiable { let id: String; let text: String; let threadId: String? }
    let id: String
    let name: String
    let path: String
    /// `chat` for a chat's hidden project (ADR 0099), which no project list shows.
    var kind: String? = nil
    var icon: String? = nil
    var badge: Badge? = nil
    var defaults: [String: ServiceValue] = [:]
    var notes: [Note] = []
    var raw: ServiceValue = .null

    private enum Keys: String, CodingKey { case id, name, path, kind, icon, badge, defaults, notes }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: Keys.self)
        id = try values.decode(String.self, forKey: .id)
        name = try values.decode(String.self, forKey: .name)
        path = try values.decode(String.self, forKey: .path)
        kind = try values.decodeIfPresent(String.self, forKey: .kind)
        icon = try? values.decodeIfPresent(String.self, forKey: .icon)
        badge = try? values.decodeIfPresent(Badge.self, forKey: .badge)
        defaults = (try? values.decodeIfPresent([String: ServiceValue].self, forKey: .defaults)) ?? [:]
        notes = (try? values.decodeIfPresent([Note].self, forKey: .notes)) ?? []
        raw = try decoder.singleValueContainer().decode(ServiceValue.self)
    }
}

/// What Edit project offers: the machine's models and local branches, and the fixed choices in
/// the web's words (`bridge/project-manage.ts`).
struct ProjectOptions: Decodable, Sendable {
    struct Model: Decodable, Sendable, Identifiable, Hashable {
        let provider: String; let id: String; let label: String
        var key: String { "\(provider)\n\(id)" }
    }
    struct Choice: Decodable, Sendable, Identifiable, Hashable {
        let id: String?; let label: String; let note: String?
        var tag: String { id ?? "" }
    }
    struct Glyph: Decodable, Sendable, Identifiable, Hashable { let id: String; let icon: String; let label: String }
    struct Colour: Decodable, Sendable, Identifiable, Hashable { let id: String; let label: String }
    struct Choices: Decodable, Sendable {
        let access: [Choice]; let browserProfiles: [Choice]; let glyphs: [Glyph]; let colours: [Colour]
    }
    let choices: Choices
    let models: [Model]
    let modelsFailed: Bool
    let branches: [String]
    let git: Bool
}

/// How a project write ended (`WriteOutcome`): taken, saved here to apply later, or refused.
struct ProjectWriteOutcome: Decodable, Sendable {
    let ok: Bool
    var queued: Bool? = nil
    /// A queued write's id, to ask for the computer's eventual answer.
    var writeId: String? = nil
    var code: String? = nil
    var message: String? = nil
}

/// The icon a person is choosing, as `@ace/ui-core` `ProjectIconChoice` reads it.
struct ProjectIconDraft: Equatable {
    enum Mode: String, CaseIterable { case auto, initials, glyph, image }
    var mode: Mode
    var color: String?
    var glyph: String
    var image: String?

    init(project: NativeProject) {
        image = project.icon
        color = project.badge?.color
        glyph = project.badge?.glyph ?? "code"
        mode = project.icon != nil ? .image : project.badge?.glyph != nil ? .glyph : project.badge != nil ? .initials : .auto
    }
    var json: [String: Any] {
        var value: [String: Any] = ["mode": mode.rawValue, "glyph": glyph]
        if let color { value["color"] = color }
        if let image { value["image"] = image }
        return value
    }
}

extension ClientModel {
    func projectOptions(_ project: NativeProject) async throws -> ProjectOptions {
        var current: [String: Any] = [:]
        if case .string(let provider) = project.defaults["provider"] { current["provider"] = provider }
        if case .string(let model) = project.defaults["model"] { current["model"] = model }
        return try await service(["type": "native.project", "request": ["op": "options", "workspaceId": project.id, "current": current]], as: ProjectOptions.self)
    }
    /// Save an edit: the bridge decides what differs (`projectEdit`) and sends only that.
    func saveProject(_ project: NativeProject, draft: [String: Any], waiting: (() -> Void)? = nil) async -> ProjectWriteOutcome {
        guard canOperate else { return ProjectWriteOutcome(ok: false, message: "This phone can only view this machine.") }
        let raw = (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(project.raw))) ?? [:]
        return await projectWrite(["op": "save", "project": raw, "draft": draft], waiting: waiting)
    }
    func removeProject(_ id: String, stopRunning: Bool, waiting: (() -> Void)? = nil) async -> ProjectWriteOutcome {
        guard canOperate else { return ProjectWriteOutcome(ok: false, message: "This phone can only view this machine.") }
        return await projectWrite(["op": "remove", "workspaceId": id, "stopRunning": stopRunning], waiting: waiting)
    }
    /// The badge initials for a name being typed, by the shared rule.
    func projectInitials(_ name: String) async -> String? {
        struct Reply: Decodable { let initials: String }
        return try? await service(["type": "native.project", "request": ["op": "initials", "name": name]], as: Reply.self).initials
    }
    /// A project write, answered only once the computer took or refused it: one still in the
    /// outbox after the bridge's wait calls `waiting` and keeps asking for its outcome, so a
    /// late refusal reaches the screen that made it.
    func projectWrite(_ request: [String: Any], waiting: (() -> Void)? = nil) async -> ProjectWriteOutcome {
        do {
            let first = try await service(["type": "native.project", "request": request], as: ProjectWriteOutcome.self)
            guard first.ok, first.queued == true, let writeId = first.writeId else { return first }
            waiting?()
            // Up to half an hour of asking; the write itself stays in the outbox regardless.
            for _ in 0..<15 where !Task.isCancelled {
                do {
                    return try await service(["type": "native.project", "request": ["op": "outcome", "writeId": writeId]], as: ProjectWriteOutcome.self, timeout: .seconds(120))
                } catch is CancellationError {
                    break
                } catch {
                    // Still waiting on the computer: the bridge keeps the answer; ask again.
                    continue
                }
            }
            return ProjectWriteOutcome(ok: false, message: "Your computer hasn't answered yet. The change is saved on this phone and applies once it does.")
        } catch { return ProjectWriteOutcome(ok: false, message: error.localizedDescription) }
    }
}
