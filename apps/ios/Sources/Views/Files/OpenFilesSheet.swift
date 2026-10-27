import SwiftUI

extension ClientModel {
    /// Tell the bridge which file this phone has open or closed (`files.opened`, `files.closed`).
    func fileOpened(_ scope: FilesScope, _ path: String) { action(["type": "files.opened", "scope": scope.wire, "path": path]) }
    func fileClosed(_ scope: FilesScope, _ path: String) { action(["type": "files.closed", "scope": scope.wire, "path": path]) }
    func watchFileMemory(_ scope: FilesScope) { action(["type": "files.memory.watch", "scope": scope.wire]) }
}

/// The toolbar's "3 open" control: the files open in this checkout, the way tabs are on the
/// computer. Nothing shows until a file has been opened.
struct OpenFilesButton: View {
    let model: ClientModel
    let scope: FilesScope
    let pick: (String) -> Void
    @State private var showing = false
    private var memory: FileMemory? { model.files.memory[scope.memoryKey] }

    var body: some View {
        if let memory, !memory.open.isEmpty || !memory.recent.isEmpty {
            Button { showing = true } label: {
                Text(memory.open.isEmpty ? "Recent" : "\(memory.open.count) open").monospacedDigit()
            }
            .accessibilityLabel(memory.open.isEmpty ? "Recent files" : "\(memory.open.count) open files")
            .accessibilityIdentifier("files.open")
            .sheet(isPresented: $showing) {
                OpenFilesSheet(model: model, scope: scope) { path in showing = false; pick(path) }
                    .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
            }
        }
    }
}

/// Open files in order, each with Close, then recently opened ones; Close others keeps the one
/// named. Swiping a row closes it too.
struct OpenFilesSheet: View {
    let model: ClientModel
    let scope: FilesScope
    let pick: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var memory: FileMemory? { model.files.memory[scope.memoryKey] }

    var body: some View {
        NavigationStack {
            List {
                if let open = memory?.open, !open.isEmpty {
                    Section("Open") {
                        ForEach(open, id: \.self) { path in
                            HStack(spacing: AceTheme.Spacing.md) {
                                Button { pick(path) } label: { row(path) }.buttonStyle(.plain)
                                Button("Close") { model.fileClosed(scope, path) }
                                    .buttonStyle(.plain).foregroundStyle(AceTheme.Colours.mutedForeground)
                                    .frame(minHeight: 44)
                                    .accessibilityIdentifier("files.close.\(path)")
                            }
                            .listRowSeparator(.hidden)
                            .swipeActions { Button("Close") { model.fileClosed(scope, path) } }
                            .contextMenu {
                                Button("Close others", systemImage: "xmark.square") {
                                    model.action(["type": "files.closed.others", "scope": scope.wire, "keep": path])
                                }
                            }
                        }
                    }
                }
                let recent = (memory?.recent ?? []).filter { !(memory?.open ?? []).contains($0) }
                if !recent.isEmpty {
                    Section("Recent") {
                        ForEach(recent, id: \.self) { path in
                            Button { pick(path) } label: { row(path) }.buttonStyle(.plain)
                                .listRowSeparator(.hidden)
                        }
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(AceTheme.Colours.background)
            .animation(reduceMotion ? nil : .smooth(duration: AceTheme.Motion.standard), value: memory)
            .navigationTitle("Files").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                if (memory?.open.count ?? 0) > 1 {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Close all") { model.action(["type": "files.closed.others", "scope": scope.wire]) }
                            .accessibilityIdentifier("files.closeAll")
                    }
                }
            }
        }
    }

    private func row(_ path: String) -> some View {
        let name = (path as NSString).lastPathComponent
        let folder = (path as NSString).deletingLastPathComponent
        return VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            Text(name).aceFont(AceTheme.Typography.body, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
            if !folder.isEmpty {
                Text(folder).aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1).truncationMode(.head)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
        .contentShape(Rectangle())
    }
}
