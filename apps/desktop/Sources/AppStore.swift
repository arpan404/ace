import Foundation
import SwiftUI

struct SidebarThread: Identifiable, Hashable, Sendable {
    let id: String
    var title: String
    var updated: String
    var projectRoot: String?

    init(id: String, title: String, updated: String, projectRoot: String?) {
        self.id = id
        self.title = title
        self.updated = updated
        self.projectRoot = projectRoot
    }

    init?(json item: [String: Any]) {
        guard let id = item["id"] as? String
            ?? item["thread_id"] as? String
            ?? item["threadId"] as? String
        else { return nil }
        self.id = id
        self.title = item["title"] as? String ?? item["name"] as? String ?? "New chat"
        self.updated = item["updatedAt"] as? String ?? item["updated_at"] as? String ?? "recent"
        self.projectRoot = item["cwd"] as? String
    }
}

struct ChatMessage: Identifiable, Hashable, Sendable {
    enum Role: Sendable {
        case user
        case assistant
        case system
    }

    let id: String
    let role: Role
    var text: String
    var pending: Bool

    init(id: String, role: Role, text: String, pending: Bool) {
        self.id = id
        self.role = role
        self.text = text
        self.pending = pending
    }

    init?(json item: [String: Any]) {
        guard let text = item["text"] as? String ?? item["content"] as? String else { return nil }
        self.id = item["id"] as? String ?? UUID().uuidString
        self.role = switch item["role"] as? String {
        case "user": .user
        case "system": .system
        default: .assistant
        }
        self.text = text
        self.pending = false
    }
}

enum SidebarSelection: Hashable, Sendable {
    case project(String)
    case thread(String)

    var id: String {
        switch self {
        case let .project(id): "project:\(id)"
        case let .thread(id): "thread:\(id)"
        }
    }
}

@MainActor
final class AppStore: ObservableObject {
    @Published private(set) var projects: [Project] = []
    @Published private(set) var threads: [SidebarThread] = []
    @Published private(set) var messages: [ChatMessage] = []
    @Published var selectedProjectId: String?
    @Published var selectedThreadId: String?
    @Published var composerText = ""
    @Published var addProjectPath = ""
    @Published var isAddProjectPresented = false
    @Published var sidebarCollapsed = false
    @Published var sidebarWidth: CGFloat = 320
    @Published var status = "Connecting"
    @Published var errorMessage: String?
    @Published var focusedArea: AppFocus = .composer
    @Published var isShortcutsPresented = false

    @AppStorage("ace.sidebar.pinnedProjectIds") private var pinnedProjectIdsStorage = ""
    @AppStorage("ace.sidebar.pinnedThreadIds") private var pinnedThreadIdsStorage = ""

    private let client: AceWebSocketClient

    init(client: AceWebSocketClient) {
        self.client = client
    }

    var pinnedProjectIds: Set<String> {
        Set(pinnedProjectIdsStorage.split(separator: ",").map(String.init))
    }

    var pinnedThreadIds: Set<String> {
        Set(pinnedThreadIdsStorage.split(separator: ",").map(String.init))
    }

    var selectedProject: Project? {
        projects.first { $0.id == selectedProjectId }
    }

    var sortedProjects: [Project] {
        projects.sorted { left, right in
            let leftPinned = pinnedProjectIds.contains(left.id)
            let rightPinned = pinnedProjectIds.contains(right.id)
            if leftPinned != rightPinned { return leftPinned }
            return left.title.localizedCaseInsensitiveCompare(right.title) == .orderedAscending
        }
    }

    var sortedThreads: [SidebarThread] {
        threads.sorted { left, right in
            let leftPinned = pinnedThreadIds.contains(left.id)
            let rightPinned = pinnedThreadIds.contains(right.id)
            if leftPinned != rightPinned { return leftPinned }
            return left.updated > right.updated
        }
    }

    var selectedSidebarItem: SidebarSelection? {
        if let selectedThreadId {
            return .thread(selectedThreadId)
        }
        if let selectedProjectId {
            return .project(selectedProjectId)
        }
        return nil
    }

    var sidebarNavigationItems: [SidebarSelection] {
        var items: [SidebarSelection] = []
        var seenThreads = Set<String>()
        let pinned = sortedThreads.filter { pinnedThreadIds.contains($0.id) }
        for thread in pinned {
            items.append(.thread(thread.id))
            seenThreads.insert(thread.id)
        }
        for project in sortedProjects {
            items.append(.project(project.id))
            for thread in sortedThreads where thread.projectRoot == project.workspaceRoot && !seenThreads.contains(thread.id) {
                items.append(.thread(thread.id))
                seenThreads.insert(thread.id)
            }
        }
        for thread in sortedThreads where !seenThreads.contains(thread.id) {
            items.append(.thread(thread.id))
        }
        return items
    }

    var selectedThreadTitle: String {
        threads.first { $0.id == selectedThreadId }?.title ?? selectedThreadId ?? "New chat"
    }

    func bootstrap() async {
        await refresh()
    }

    func refresh() async {
        errorMessage = nil
        status = "Loading"
        do {
            async let projectResponse: [Project] = client.request(
                method: WsMethod.projectsList,
                payload: EmptyPayload()
            )
            async let threadResponse: ThreadListResponse = client.request(
                method: WsMethod.codexThreadsList,
                payload: ThreadsListRequest(includeArchived: false, limit: 80)
            )
            applySidebarSnapshot(
                projects: try await projectResponse,
                threads: try await threadResponse.threads
            )
            focusedArea = .composer
            status = "Ready"
        } catch {
            errorMessage = error.localizedDescription
            status = "Offline"
        }
    }

    func presentAddProject() {
        isAddProjectPresented = true
    }

    func presentShortcuts() {
        isShortcutsPresented = true
    }

    func applySidebarSnapshot(projects: [Project], threads: [SidebarThread]) {
        self.projects = projects
        self.threads = threads
        selectedProjectId = selectedProjectId ?? projects.first?.id
        selectedThreadId = selectedThreadId ?? threads.first?.id
    }

    func addProject() async {
        let path = addProjectPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else { return }
        do {
            let project: Project = try await client.request(
                method: WsMethod.projectsAdd,
                payload: ProjectAddRequest(
                    workspaceRoot: path,
                    title: nil,
                    defaultModelSelection: nil
                )
            )
            if !projects.contains(where: { $0.id == project.id }) {
                projects.insert(project, at: 0)
            }
            selectedProjectId = project.id
            addProjectPath = ""
            isAddProjectPresented = false
            status = "Project added"
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func createThread() async {
        do {
            let response: ThreadStartResponse = try await client.request(
                method: WsMethod.codexThreadStart,
                payload: ThreadStartRequest(
                    cwd: selectedProject?.workspaceRoot,
                    model: "gpt-5.5",
                    approvalPolicy: ["preset": "on-request"]
                )
            )
            let thread = SidebarThread(
                id: response.threadId,
                title: "New chat",
                updated: "now",
                projectRoot: selectedProject?.workspaceRoot
            )
            threads.insert(thread, at: 0)
            selectedThreadId = response.threadId
            messages = []
            focusedArea = .composer
            status = "Thread ready"
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func selectThread(_ thread: SidebarThread) async {
        selectedThreadId = thread.id
        selectedProjectId = projectForThread(thread)?.id ?? selectedProjectId
        messages = []
        do {
            let response: ThreadReadResponse = try await client.request(
                method: WsMethod.codexThreadRead,
                payload: ThreadIdRequest(threadId: thread.id)
            )
            messages = response.messages
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func sendComposer() async {
        let prompt = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return }
        if selectedThreadId == nil {
            await createThread()
        }
        guard let threadId = selectedThreadId else { return }
        composerText = ""
        messages.append(ChatMessage(id: UUID().uuidString, role: .user, text: prompt, pending: true))
        do {
            let _: AnyJSON = try await client.request(
                method: WsMethod.codexTurnStart,
                payload: TurnStartRequest(threadId: threadId, prompt: prompt, model: "gpt-5.5")
            )
            messages = messages.map { message in
                var next = message
                next.pending = false
                return next
            }
            status = "Message sent"
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func toggleSidebar() {
        sidebarCollapsed.toggle()
        focusedArea = sidebarCollapsed ? .composer : .sidebar
    }

    func focusComposer() {
        focusedArea = .composer
    }

    func focusSidebar() {
        sidebarCollapsed = false
        focusedArea = .sidebar
    }

    func selectNextSidebarItem() {
        moveSidebarSelection(offset: 1)
    }

    func selectPreviousSidebarItem() {
        moveSidebarSelection(offset: -1)
    }

    func activateSelectedSidebarItem() async {
        guard let item = selectedSidebarItem else {
            if let first = sidebarNavigationItems.first {
                await selectSidebarItem(first)
            }
            return
        }
        await selectSidebarItem(item)
    }

    func togglePinnedSelectedItem() {
        guard let item = selectedSidebarItem else { return }
        switch item {
        case let .project(id):
            togglePinnedProject(id)
        case let .thread(id):
            togglePinnedThread(id)
        }
    }

    func togglePinnedProject(_ id: String) {
        pinnedProjectIdsStorage = toggledCSV(pinnedProjectIdsStorage, id)
    }

    func togglePinnedThread(_ id: String) {
        pinnedThreadIdsStorage = toggledCSV(pinnedThreadIdsStorage, id)
    }

    func updateSidebarWidth(_ width: CGFloat) {
        let clamped = min(max(width, 240), 420)
        if abs(sidebarWidth - clamped) > 0.5 {
            sidebarWidth = clamped
        }
    }

    private func moveSidebarSelection(offset: Int) {
        let items = sidebarNavigationItems
        guard !items.isEmpty else { return }
        let currentIndex = selectedSidebarItem.flatMap { items.firstIndex(of: $0) } ?? -1
        let nextIndex = min(max(currentIndex + offset, 0), items.count - 1)
        let item = items[nextIndex]
        switch item {
        case let .project(id):
            selectedProjectId = id
            selectedThreadId = nil
        case let .thread(id):
            selectedThreadId = id
            if let thread = threads.first(where: { $0.id == id }) {
                selectedProjectId = projectForThread(thread)?.id ?? selectedProjectId
            }
        }
    }

    private func selectSidebarItem(_ item: SidebarSelection) async {
        switch item {
        case let .project(id):
            selectedProjectId = id
            selectedThreadId = nil
            messages = []
        case let .thread(id):
            guard let thread = threads.first(where: { $0.id == id }) else { return }
            await selectThread(thread)
        }
    }

    private func projectForThread(_ thread: SidebarThread) -> Project? {
        guard let root = thread.projectRoot else { return nil }
        return projects.first { $0.workspaceRoot == root }
    }

    private func toggledCSV(_ csv: String, _ id: String) -> String {
        var values = csv.split(separator: ",").map(String.init)
        if let index = values.firstIndex(of: id) {
            values.remove(at: index)
        } else {
            values.append(id)
        }
        return values.joined(separator: ",")
    }
}
