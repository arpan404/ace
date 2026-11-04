import Foundation

/// A start asked for outside the app (the share sheet, Siri and Shortcuts): what to start and
/// where, kept on disk until the app has saved it as a real start. The extension and the intents
/// can't run the shared runtime, so they only queue; the app sends it through New thread under
/// `id`, so a second pass over the same handoff replays that one start instead of a second one.
struct Handoff: Codable, Equatable, Sendable, Identifiable {
    /// A lowercase UUID; it is also the start's command id.
    let id: String
    let created: Date
    /// The machine and project picked where it was asked for; nil leaves it to the app's memory.
    var machineId: String?
    var projectId: String?
    var text: String
    /// Images and files shared with it, copied beside the handoff.
    var files: [HandoffFile] = []
    /// Where it came from, for the sheet's one line ("From Share").
    var source: Source

    enum Source: String, Codable, Sendable { case share, shortcut }
}

/// A file shared with a handoff: its bytes sit in the handoff's folder under `stored`.
struct HandoffFile: Codable, Equatable, Sendable {
    let stored: String
    let name: String
    let mimeType: String
}

/// The projects a share or a shortcut can start in, as the app last read them: written by the
/// app, read by the share extension and the intents. Names machines and projects by id; no
/// secret, no address.
struct HandoffCatalogue: Codable, Equatable, Sendable {
    struct Machine: Codable, Equatable, Sendable, Identifiable {
        let id: String
        let name: String
        var canOperate = true
    }
    struct Project: Codable, Equatable, Sendable, Identifiable {
        let machineId: String
        let projectId: String
        let name: String
        var id: String { machineId + "\u{0}" + projectId }
    }
    var machines: [Machine] = []
    /// Recent projects first, per machine in pairing order.
    var projects: [Project] = []
    /// The machine and project New thread was last started in.
    var lastMachine: String?
    var lastProject: String?

    /// Where a share starts unless the person picks: the last project, else the first listed,
    /// else a chat on the first machine that can start threads.
    var suggested: Project? {
        if let lastMachine, let lastProject,
           let last = projects.first(where: { $0.machineId == lastMachine && $0.projectId == lastProject }) {
            return last
        }
        return projects.first { project in machines.first { $0.id == project.machineId }?.canOperate ?? false }
    }
    /// A machine's name, when the catalogue knows more than one machine and it reads better named.
    func machineName(_ id: String) -> String? {
        machines.count > 1 ? machines.first { $0.id == id }?.name : nil
    }
}
