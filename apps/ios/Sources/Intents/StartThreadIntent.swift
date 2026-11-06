import AppIntents
import Foundation

/// A project to start in, from the machines and projects the app last read (`HandoffCatalogue`):
/// Siri, Shortcuts and Spotlight list them without the app running.
struct ProjectEntity: AppEntity, Identifiable {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Project"
    static let defaultQuery = ProjectQuery()
    let id: String
    let machineId: String
    let projectId: String
    let name: String
    /// The machine's name when there's more than one.
    let machine: String?

    init(_ project: HandoffCatalogue.Project, catalogue: HandoffCatalogue) {
        id = project.id; machineId = project.machineId; projectId = project.projectId; name = project.name
        machine = catalogue.machineName(project.machineId)
    }
    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)", subtitle: machine.map { "\($0)" })
    }
}

struct ProjectQuery: EntityStringQuery {
    private var catalogue: HandoffCatalogue { HandoffStore.shared()?.catalogue() ?? HandoffCatalogue() }
    private func entities(_ projects: [HandoffCatalogue.Project]) -> [ProjectEntity] {
        let catalogue = catalogue
        return projects.map { ProjectEntity($0, catalogue: catalogue) }
    }
    func entities(for identifiers: [String]) async throws -> [ProjectEntity] {
        entities(catalogue.projects.filter { identifiers.contains($0.id) })
    }
    func entities(matching string: String) async throws -> [ProjectEntity] {
        entities(catalogue.projects.filter { $0.name.localizedCaseInsensitiveContains(string) })
    }
    func suggestedEntities() async throws -> [ProjectEntity] { entities(catalogue.projects) }
    func defaultResult() async -> ProjectEntity? {
        let catalogue = catalogue
        return catalogue.suggested.map { ProjectEntity($0, catalogue: catalogue) }
    }
}

/// "Start a thread in ace": the words and, if picked, the project. ace opens and starts it from New
/// thread, where the person sees it go and lands in the thread.
struct StartThreadIntent: AppIntent {
    static let title: LocalizedStringResource = "Start a thread"
    static let description = IntentDescription("Starts a thread in ace with what you want done.")
    static let openAppWhenRun = true

    @Parameter(title: "Task", inputOptions: String.IntentInputOptions(multiline: true), requestValueDialog: "What should the agent do?")
    var prompt: String
    @Parameter(title: "Project")
    var project: ProjectEntity?

    static var parameterSummary: some ParameterSummary {
        Summary("Start a thread: \(\.$prompt)") { \.$project }
    }

    @MainActor func perform() async throws -> some IntentResult {
        let words = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { throw $prompt.needsValueError() }
        guard let store = HandoffStore.shared() else { throw StartThreadError.unavailable }
        let handoff = Handoff(id: UUID().uuidString.lowercased(), created: Date(), machineId: project?.machineId,
                              projectId: project?.projectId, text: words, source: .shortcut)
        try store.add(handoff)
        return .result()
    }
}

enum StartThreadError: Error, CustomLocalizedStringResourceConvertible {
    case unavailable
    var localizedStringResource: LocalizedStringResource { "ace couldn't keep that on this phone. Open ace and start it there." }
}

/// "Open ace inbox": ace in front, on its inbox.
struct OpenInboxIntent: AppIntent {
    static let title: LocalizedStringResource = "Open inbox"
    static let description = IntentDescription("Opens ace's inbox.")
    static let openAppWhenRun = true
    @MainActor func perform() async throws -> some IntentResult { .result() }
}

struct AceShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: StartThreadIntent(), phrases: [
            "Start a thread in \(.applicationName)",
            "New \(.applicationName) thread",
        ], shortTitle: "Start a thread", systemImageName: "square.and.pencil")
        AppShortcut(intent: OpenInboxIntent(), phrases: [
            "Open \(.applicationName) inbox",
            "Show my \(.applicationName) inbox",
        ], shortTitle: "Open inbox", systemImageName: "tray")
    }
}
