import SwiftUI

struct RootView: View {
    @EnvironmentObject private var store: AppStore
    @FocusState private var focusedArea: AppFocus?

    var body: some View {
        HSplitView {
            if !store.sidebarCollapsed {
                SidebarView(focusedArea: $focusedArea)
                    .frame(minWidth: 248, idealWidth: store.sidebarWidth, maxWidth: 440)
                    .background {
                        GeometryReader { proxy in
                            Color.clear
                                .onAppear { store.updateSidebarWidth(proxy.size.width) }
                                .onChange(of: proxy.size.width) { _, width in
                                    store.updateSidebarWidth(width)
                                }
                        }
                    }
            }

            ChatWorkspaceView(focusedArea: $focusedArea)
                .frame(minWidth: 680)
        }
        .background(Color.appBackground)
        .onAppear { focusedArea = store.focusedArea }
        .onChange(of: store.focusedArea) { _, focus in focusedArea = focus }
        .onChange(of: focusedArea) { _, focus in
            if let focus {
                store.focusedArea = focus
            }
        }
        .onMoveCommand { direction in
            guard focusedArea == .sidebar else { return }
            switch direction {
            case .up:
                store.selectPreviousSidebarItem()
            case .down:
                store.selectNextSidebarItem()
            default:
                break
            }
        }
        .sheet(isPresented: $store.isAddProjectPresented) {
            AddProjectSheet()
                .environmentObject(store)
        }
        .sheet(isPresented: $store.isShortcutsPresented) {
            ShortcutsSheet()
        }
    }
}

struct SidebarView: View {
    @EnvironmentObject private var store: AppStore
    var focusedArea: FocusState<AppFocus?>.Binding

    private var pinnedThreads: [SidebarThread] {
        store.sortedThreads.filter { store.pinnedThreadIds.contains($0.id) }
    }

    var body: some View {
        VStack(spacing: 0) {
            SidebarHeader()
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: AppSpacing.lg) {
                        pinnedSection
                        projectsSection
                        unscopedThreadsSection
                    }
                    .padding(.horizontal, AppSpacing.md)
                    .padding(.vertical, AppSpacing.md)
                }
                .focused(focusedArea, equals: .sidebar)
                .focusable()
                .onChange(of: store.selectedSidebarItem?.id) { _, id in
                    if let id {
                        withAnimation(.snappy(duration: 0.16)) {
                            proxy.scrollTo(id, anchor: .center)
                        }
                    }
                }
            }
            Divider()
            SidebarFooter()
        }
        .background(Color.sidebarBackground)
    }

    private var pinnedSection: some View {
        VStack(alignment: .leading, spacing: AppSpacing.sm) {
            HStack {
                AppSectionLabel(title: "Pinned")
                Spacer()
                ShortcutHint(text: "⌘⇧P")
            }
            if pinnedThreads.isEmpty {
                EmptySidebarHint(text: "Pin active projects or threads for quick access.")
            } else {
                ForEach(pinnedThreads) { thread in
                    ThreadRow(thread: thread, compact: true)
                        .id(SidebarSelection.thread(thread.id).id)
                }
            }
        }
    }

    private var projectsSection: some View {
        VStack(alignment: .leading, spacing: AppSpacing.sm) {
            HStack {
                AppSectionLabel(title: "Projects")
                Spacer()
                IconButton(title: "Add Project", icon: .addProject) {
                    store.presentAddProject()
                }
            }
            if store.sortedProjects.isEmpty {
                EmptySidebarHint(text: "Add a workspace to start a project thread.")
            } else {
                ForEach(store.sortedProjects) { project in
                    ProjectSection(project: project)
                        .id(SidebarSelection.project(project.id).id)
                }
            }
        }
    }

    private var unscopedThreadsSection: some View {
        let threads = store.sortedThreads.filter { thread in
            thread.projectRoot == nil && !store.pinnedThreadIds.contains(thread.id)
        }
        return Group {
            if !threads.isEmpty {
                VStack(alignment: .leading, spacing: AppSpacing.sm) {
                    AppSectionLabel(title: "Threads")
                    ForEach(threads) { thread in
                        ThreadRow(thread: thread, compact: false)
                            .id(SidebarSelection.thread(thread.id).id)
                    }
                }
            }
        }
    }
}

struct SidebarHeader: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        VStack(spacing: AppSpacing.sm) {
            HStack(spacing: AppSpacing.sm) {
                Button {
                    Task { await store.createThread() }
                } label: {
                    Label {
                        Text("New chat")
                            .fontWeight(.semibold)
                    } icon: {
                        AppIcon.newThread.image
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.regular)
                .keyboardShortcut("n", modifiers: [.command])

                IconButton(title: "Hide Sidebar", icon: .collapseSidebar) {
                    store.toggleSidebar()
                }
            }

            HStack(spacing: AppSpacing.sm) {
                HeaderQuickAction(title: "Sidebar", shortcut: "⌘1") {
                    store.focusSidebar()
                }
                HeaderQuickAction(title: "Composer", shortcut: "⌘L") {
                    store.focusComposer()
                }
            }
        }
        .padding(AppSpacing.md)
    }
}

struct HeaderQuickAction: View {
    let title: String
    let shortcut: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: AppSpacing.xs) {
                Text(title)
                Spacer()
                ShortcutHint(text: shortcut)
            }
            .font(.caption)
            .padding(.horizontal, AppSpacing.sm)
            .frame(height: 28)
            .background(Color.panelBackground)
            .clipShape(RoundedRectangle(cornerRadius: AppRadius.sm))
        }
        .buttonStyle(.plain)
    }
}

struct ProjectSection: View {
    @EnvironmentObject private var store: AppStore
    let project: Project
    @State private var expanded = true

    private var projectThreads: [SidebarThread] {
        store.sortedThreads.filter {
            $0.projectRoot == project.workspaceRoot && !store.pinnedThreadIds.contains($0.id)
        }
    }

    private var selected: Bool {
        store.selectedSidebarItem == .project(project.id)
    }

    var body: some View {
        VStack(spacing: AppSpacing.xs) {
            SidebarRow(
                selected: selected,
                leadingIcon: .folder,
                title: project.title,
                subtitle: project.workspaceRoot,
                accessory: {
                    HStack(spacing: AppSpacing.xs) {
                        IconButton(
                            title: store.pinnedProjectIds.contains(project.id) ? "Unpin Project" : "Pin Project",
                            icon: store.pinnedProjectIds.contains(project.id) ? .pinned : .pin
                        ) {
                            store.togglePinnedProject(project.id)
                        }
                        IconButton(title: "New Thread in Project", icon: .newThread) {
                            store.selectedProjectId = project.id
                            Task { await store.createThread() }
                        }
                        IconButton(title: expanded ? "Collapse Project" : "Expand Project", icon: expanded ? .expanded : .expand) {
                            expanded.toggle()
                        }
                    }
                },
                action: {
                    store.selectedProjectId = project.id
                    store.selectedThreadId = nil
                }
            )

            if expanded {
                if projectThreads.isEmpty {
                    EmptySidebarHint(text: "No threads yet.")
                        .padding(.leading, AppSpacing.lg)
                } else {
                    ForEach(projectThreads) { thread in
                        ThreadRow(thread: thread, compact: false)
                            .padding(.leading, AppSpacing.lg)
                            .id(SidebarSelection.thread(thread.id).id)
                    }
                }
            }
        }
    }
}

struct ThreadRow: View {
    @EnvironmentObject private var store: AppStore
    let thread: SidebarThread
    var compact: Bool

    private var selected: Bool {
        store.selectedSidebarItem == .thread(thread.id)
    }

    var body: some View {
        SidebarRow(
            selected: selected,
            leadingIcon: .assistant,
            title: thread.title,
            subtitle: compact ? thread.projectRoot : thread.updated,
            accessory: {
                IconButton(
                    title: store.pinnedThreadIds.contains(thread.id) ? "Unpin Thread" : "Pin Thread",
                    icon: store.pinnedThreadIds.contains(thread.id) ? .pinned : .pin
                ) {
                    store.togglePinnedThread(thread.id)
                }
            },
            action: {
                Task { await store.selectThread(thread) }
            }
        )
    }
}

struct SidebarRow<Accessory: View>: View {
    let selected: Bool
    let leadingIcon: AppIcon
    let title: String
    let subtitle: String?
    @ViewBuilder let accessory: () -> Accessory
    let action: () -> Void

    @State private var hovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: AppSpacing.sm) {
                leadingIcon.image
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                    .frame(width: 18)

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: 13, weight: selected ? .semibold : .regular))
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                    if let subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }

                Spacer(minLength: AppSpacing.sm)
                accessory()
                    .opacity(hovered || selected ? 1 : 0.68)
            }
            .padding(.horizontal, AppSpacing.sm)
            .frame(minHeight: 34)
            .background(selected ? Color.selectionBackground : hovered ? Color.hoverBackground : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: AppRadius.md))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
    }
}

struct EmptySidebarHint: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.horizontal, AppSpacing.sm)
            .padding(.vertical, AppSpacing.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.panelBackground.opacity(0.6))
            .clipShape(RoundedRectangle(cornerRadius: AppRadius.md))
    }
}

struct SidebarFooter: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        HStack(spacing: AppSpacing.sm) {
            (store.status == "Ready" ? AppIcon.connected : AppIcon.disconnected).image
                .foregroundStyle(store.errorMessage == nil ? Color.green : Color.red)
            Text(store.errorMessage ?? store.status)
                .lineLimit(1)
            Spacer()
            IconButton(title: "Refresh", icon: .refresh) {
                Task { await store.refresh() }
            }
        }
        .font(.caption)
        .foregroundStyle(store.errorMessage == nil ? Color.secondary : Color.red)
        .padding(.horizontal, AppSpacing.md)
        .frame(height: 42)
    }
}

struct ChatWorkspaceView: View {
    @EnvironmentObject private var store: AppStore
    var focusedArea: FocusState<AppFocus?>.Binding

    var body: some View {
        VStack(spacing: 0) {
            ChatToolbar()
            Divider()
            MessageTranscript()
            Divider()
            ComposerBar(focusedArea: focusedArea)
        }
        .background(Color.appBackground)
    }
}

struct ChatToolbar: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        HStack(spacing: AppSpacing.md) {
            if store.sidebarCollapsed {
                IconButton(title: "Show Sidebar", icon: .collapseSidebar, prominent: true) {
                    store.toggleSidebar()
                }
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(store.selectedThreadTitle)
                    .font(.headline)
                    .lineLimit(1)
                Text(store.selectedProject?.title ?? "No project selected")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            IconButton(title: "Pin Selection", icon: .pin) {
                store.togglePinnedSelectedItem()
            }

            IconButton(title: "Keyboard Shortcuts", icon: .keyboard) {
                store.presentShortcuts()
            }
        }
        .padding(.horizontal, AppSpacing.lg)
        .frame(height: 54)
    }
}

struct MessageTranscript: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: AppSpacing.md) {
                if store.messages.isEmpty {
                    EmptyConversationView()
                } else {
                    ForEach(store.messages) { message in
                        MessageBubble(message: message)
                    }
                }
            }
            .padding(.horizontal, 32)
            .padding(.vertical, AppSpacing.xl)
            .frame(maxWidth: 920)
            .frame(maxWidth: .infinity)
        }
    }
}

struct EmptyConversationView: View {
    var body: some View {
        VStack(spacing: AppSpacing.md) {
            AppIcon.commandPalette.image
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(Color.accentColor)
            Text("Ready for the next change")
                .font(.title3.weight(.semibold))
            Text("Use the sidebar with ↑ ↓ and Return, or jump straight to the composer with ⌘L.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
        }
        .frame(maxWidth: .infinity, minHeight: 360)
    }
}

struct MessageBubble: View {
    let message: ChatMessage

    var body: some View {
        HStack(alignment: .top, spacing: AppSpacing.sm) {
            if message.role == .user { Spacer(minLength: 100) }
            roleIcon
            Text(message.text)
                .font(.body)
                .foregroundStyle(message.pending ? .secondary : .primary)
                .textSelection(.enabled)
                .padding(AppSpacing.md)
                .background(background)
                .clipShape(RoundedRectangle(cornerRadius: AppRadius.lg))
            if message.role != .user { Spacer(minLength: 100) }
        }
    }

    private var roleIcon: some View {
        Group {
            switch message.role {
            case .user:
                AppIcon.user.image
            case .assistant:
                AppIcon.assistant.image
            case .system:
                AppIcon.keyboard.image
            }
        }
        .font(.system(size: 16, weight: .semibold))
        .foregroundStyle(.secondary)
        .frame(width: 22, height: 22)
    }

    private var background: Color {
        switch message.role {
        case .user:
            Color.userBubbleBackground
        case .assistant:
            Color.assistantBubbleBackground
        case .system:
            Color.panelBackground
        }
    }
}

struct ComposerBar: View {
    @EnvironmentObject private var store: AppStore
    var focusedArea: FocusState<AppFocus?>.Binding

    var body: some View {
        HStack(alignment: .bottom, spacing: AppSpacing.md) {
            VStack(alignment: .leading, spacing: AppSpacing.sm) {
                HStack(spacing: AppSpacing.sm) {
                    TextField("Ask for follow-up changes", text: $store.composerText, axis: .vertical)
                        .textFieldStyle(.plain)
                        .focused(focusedArea, equals: .composer)
                        .lineLimit(1...7)
                        .onSubmit {
                            Task { await store.sendComposer() }
                        }
                    ShortcutHint(text: "⌘↩")
                }
                .padding(.horizontal, AppSpacing.md)
                .padding(.vertical, 10)
                .background(Color.panelBackground)
                .clipShape(RoundedRectangle(cornerRadius: AppRadius.lg))

                HStack {
                    Text("⌘1 sidebar  ·  ↑↓ navigate  ·  Return open  ·  ⌘⇧P pin")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                }
            }

            Button {
                Task { await store.sendComposer() }
            } label: {
                AppIcon.send.image
                    .font(.system(size: 24, weight: .semibold))
            }
            .buttonStyle(.plain)
            .foregroundStyle(store.composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? Color.secondary : Color.accentColor)
            .disabled(store.composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .keyboardShortcut(.return, modifiers: [.command])
            .help("Send Message")
        }
        .padding(AppSpacing.lg)
    }
}

struct AddProjectSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.lg) {
            VStack(alignment: .leading, spacing: AppSpacing.xs) {
                Text("Add Project")
                    .font(.title2.weight(.semibold))
                Text("Choose a workspace path that the backend can access.")
                    .foregroundStyle(.secondary)
            }

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
                .keyboardShortcut(.cancelAction)
                Button("Add") {
                    Task { await store.addProject() }
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(AppSpacing.xl)
        .frame(width: 480)
        .onAppear { focused = true }
    }
}

struct ShortcutsSheet: View {
    private let shortcuts: [(String, String)] = [
        ("New thread", "⌘N"),
        ("Focus sidebar", "⌘1"),
        ("Focus composer", "⌘L"),
        ("Add project", "⌘O"),
        ("Refresh", "⌘R"),
        ("Pin selected item", "⌘⇧P"),
        ("Open selected sidebar item", "Return"),
        ("Move in sidebar", "↑ / ↓"),
        ("Show or hide sidebar", "⌘B"),
        ("Show shortcuts", "⌘/")
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.lg) {
            Text("Keyboard Shortcuts")
                .font(.title2.weight(.semibold))
            Grid(alignment: .leading, horizontalSpacing: 28, verticalSpacing: AppSpacing.md) {
                ForEach(shortcuts, id: \.0) { label, shortcut in
                    GridRow {
                        Text(label)
                            .foregroundStyle(.primary)
                        ShortcutHint(text: shortcut)
                    }
                }
            }
        }
        .padding(AppSpacing.xl)
        .frame(width: 420)
    }
}
