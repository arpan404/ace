import SwiftUI

struct RootView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        HSplitView {
            if !store.sidebarCollapsed {
                SidebarView()
                    .frame(minWidth: 240, idealWidth: store.sidebarWidth, maxWidth: 420)
                    .background {
                        GeometryReader { proxy in
                            Color.clear
                                .onAppear {
                                    store.updateSidebarWidth(proxy.size.width)
                                }
                                .onChange(of: proxy.size.width) { _, width in
                                    store.updateSidebarWidth(width)
                                }
                        }
                    }
            }

            ChatWorkspaceView()
                .frame(minWidth: 680)
        }
        .background(Color.appBackground)
        .sheet(isPresented: $store.isAddProjectPresented) {
            AddProjectSheet()
                .environmentObject(store)
        }
    }
}

struct SidebarView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    sectionTitle("Pinned")
                    pinnedThreads
                    projects
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 12)
            }
            Divider()
            footer
        }
        .background(Color.sidebarBackground)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Button {
                Task { await store.createThread() }
            } label: {
                Label {
                    Text("New chat")
                } icon: {
                    AppIcon.newThread.image
                }
            }
            .buttonStyle(.plain)
            Spacer()
            Button {
                store.presentAddProject()
            } label: {
                AppIcon.addProject.image
            }
            .buttonStyle(.plain)
            Button {
                store.toggleSidebar()
            } label: {
                AppIcon.collapseSidebar.image
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12)
        .frame(height: 48)
    }

    private var pinnedThreads: some View {
        VStack(spacing: 4) {
            ForEach(store.sortedThreads.filter { store.pinnedThreadIds.contains($0.id) }) { thread in
                ThreadRow(thread: thread)
            }
            if store.pinnedThreadIds.isEmpty {
                Text("No pinned threads")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 8)
            }
        }
    }

    private var projects: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                sectionTitle("Projects")
                Spacer()
                Button {
                    store.presentAddProject()
                } label: {
                    AppIcon.add.image
                }
                .buttonStyle(.plain)
            }
            ForEach(store.sortedProjects) { project in
                ProjectSection(project: project)
            }
        }
    }

    private var footer: some View {
        HStack {
            (store.status == "Ready" ? AppIcon.connected : AppIcon.disconnected).image
            Text(store.errorMessage ?? store.status)
                .lineLimit(1)
            Spacer()
        }
        .font(.caption)
        .foregroundStyle(store.errorMessage == nil ? Color.secondary : Color.red)
        .padding(.horizontal, 12)
        .frame(height: 42)
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(title.uppercased())
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
    }
}

struct ProjectSection: View {
    @EnvironmentObject private var store: AppStore
    let project: Project
    @State private var expanded = true

    var body: some View {
        VStack(spacing: 4) {
            HStack(spacing: 8) {
                Button {
                    expanded.toggle()
                    store.selectedProjectId = project.id
                } label: {
                    (expanded ? AppIcon.expanded : AppIcon.expand).image
                    AppIcon.folder.image
                    Text(project.title)
                        .lineLimit(1)
                    Spacer()
                }
                .buttonStyle(.plain)

                Button {
                    store.togglePinnedProject(project.id)
                } label: {
                    (store.pinnedProjectIds.contains(project.id) ? AppIcon.pinned : AppIcon.pin).image
                }
                .buttonStyle(.plain)

                Button {
                    store.selectedProjectId = project.id
                    Task { await store.createThread() }
                } label: {
                    AppIcon.newThread.image
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 8)
            .frame(height: 30)
            .background(store.selectedProjectId == project.id ? Color.selectionBackground : .clear)
            .clipShape(RoundedRectangle(cornerRadius: 6))

            if expanded {
                ForEach(store.sortedThreads.filter { $0.projectRoot == project.workspaceRoot }) { thread in
                    ThreadRow(thread: thread)
                        .padding(.leading, 22)
                }
            }
        }
    }
}

struct ThreadRow: View {
    @EnvironmentObject private var store: AppStore
    let thread: SidebarThread

    var body: some View {
        HStack(spacing: 8) {
            Button {
                Task { await store.selectThread(thread) }
            } label: {
                Text(thread.title)
                    .lineLimit(1)
                Spacer()
                Text(thread.updated)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)

            Button {
                store.togglePinnedThread(thread.id)
            } label: {
                (store.pinnedThreadIds.contains(thread.id) ? AppIcon.pinned : AppIcon.pin).image
                    .font(.caption)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 8)
        .frame(height: 30)
        .background(store.selectedThreadId == thread.id ? Color.selectionBackground : .clear)
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

struct ChatWorkspaceView: View {
    @EnvironmentObject private var store: AppStore
    @FocusState private var composerFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button {
                    store.toggleSidebar()
                } label: {
                    AppIcon.collapseSidebar.image
                }
                .buttonStyle(.plain)
                Text(store.selectedThreadId ?? "New chat")
                    .font(.headline)
                Spacer()
            }
            .padding(.horizontal, 16)
            .frame(height: 48)
            Divider()

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if store.messages.isEmpty {
                        Text("Select a thread or start a new one.")
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, minHeight: 300)
                    } else {
                        ForEach(store.messages) { message in
                            MessageBubble(message: message)
                        }
                    }
                }
                .padding(24)
            }

            Divider()
            HStack(alignment: .bottom, spacing: 10) {
                TextField("Ask for follow-up changes", text: $store.composerText, axis: .vertical)
                    .textFieldStyle(.plain)
                    .focused($composerFocused)
                    .lineLimit(1...6)
                    .padding(12)
                    .background(Color.panelBackground)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .onSubmit {
                        Task { await store.sendComposer() }
                    }

                Button {
                    Task { await store.sendComposer() }
                } label: {
                    AppIcon.send.image
                        .font(.title2)
                }
                .buttonStyle(.plain)
                .disabled(store.composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(16)
        }
        .background(Color.appBackground)
    }
}

struct MessageBubble: View {
    let message: ChatMessage

    var body: some View {
        HStack {
            if message.role == .user { Spacer(minLength: 80) }
            Text(message.text)
                .foregroundStyle(message.pending ? .secondary : .primary)
                .padding(12)
                .background(message.role == .user ? Color.panelBackground : Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: 12))
            if message.role != .user { Spacer(minLength: 80) }
        }
    }
}

struct AddProjectSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Add Project")
                .font(.title2.weight(.semibold))
            TextField("/path/to/workspace", text: $store.addProjectPath)
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .onSubmit {
                    Task { await store.addProject() }
                }
            HStack {
                Spacer()
                Button("Cancel") {
                    dismiss()
                }
                Button("Add") {
                    Task { await store.addProject() }
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 460)
        .onAppear { focused = true }
    }
}

extension Color {
    static let appBackground = Color(nsColor: .windowBackgroundColor)
    static let sidebarBackground = Color(nsColor: .underPageBackgroundColor)
    static let panelBackground = Color(nsColor: .controlBackgroundColor)
    static let selectionBackground = Color.accentColor.opacity(0.18)
}
