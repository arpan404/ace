import Foundation

struct TaskProfile: Codable, Equatable, Identifiable {
    let id: String
    var name: String
    var instructions: String
}
/// Phone-owned reusable instructions. Every screen receives the store; profiles never contain
/// provider credentials and are included explicitly in a new task's first user message.
struct TaskProfileStore {
    let defaults: UserDefaults
    private let key = "ace.taskProfiles"
    func load() -> [TaskProfile] {
        guard let data = defaults.data(forKey: key), let rows = try? JSONDecoder().decode([TaskProfile].self, from: data) else { return [] }
        return Array(rows.filter { !$0.id.isEmpty && !$0.name.isEmpty && $0.name.count <= 128 && $0.instructions.count <= 16384 }.prefix(64))
    }
    func save(_ profile: TaskProfile) throws {
        guard !profile.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, profile.name.count <= 128, profile.instructions.count <= 16384 else {
            throw ServiceFailure(message: "Use a name up to 128 characters and instructions up to 16,384 characters.")
        }
        var rows = load()
        if let index = rows.firstIndex(where: { $0.id == profile.id }) { rows[index] = profile }
        else { guard rows.count < 64 else { throw ServiceFailure(message: "Remove a profile before adding another.") }; rows.append(profile) }
        try persist(rows)
    }
    func remove(_ id: String) throws { try persist(load().filter { $0.id != id }) }
    private func persist(_ rows: [TaskProfile]) throws { defaults.set(try JSONEncoder().encode(rows), forKey: key) }
}
extension NewThreadDraft {
    var outgoingText: String {
        guard let instructions, !instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return text }
        return "Instructions:\n\(instructions)\n\nTask:\n\(text)"
    }
}
