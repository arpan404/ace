import SwiftUI

/// One part of a file too large to edit whole, edited on its own: the system find navigator
/// (with replace) works in it, and Save writes it over exactly the bytes it was read from, at
/// the version it was read at. A file that changed since then is never overwritten: the person
/// reads it again and redoes the edit there.
struct FilePartEditor: View {
    let model: ClientModel
    let scope: FilesScope
    let path: String
    let part: LargeFileText.Part
    let version: String
    /// The editor closed: true once the part was saved.
    let finished: (Bool) -> Void
    @State private var handle = SourceHandle()
    @State private var dirty = false
    @State private var saving = false
    @State private var problem: String?
    @State private var changed = false
    @State private var confirmDiscard = false

    var body: some View {
        NavigationStack {
            SourceTextView(document: SourceDocument(key: "\(path)|\(version)|\(part.offset)", text: part.text, language: nil, marks: [:]),
                           wrap: true, editable: true, line: nil, handle: handle, dirty: { dirty = $0 })
                .ignoresSafeArea(.container, edges: .bottom)
                .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) { strip }
                .navigationTitle("Lines \((part.firstLine + 1).formatted())–\((part.firstLine + max(part.lines.count, 1)).formatted())")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { if dirty { confirmDiscard = true } else { finished(false) } }.disabled(saving)
                            .accessibilityIdentifier("file.part.cancel")
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Find", systemImage: "magnifyingglass") { handle.find() }
                            .accessibilityIdentifier("file.part.find")
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(saving ? "Saving…" : "Save") { save() }.fontWeight(.semibold).disabled(!dirty || saving || changed)
                            .accessibilityIdentifier("file.part.save")
                    }
                }
                .confirmationDialog("Discard your changes?", isPresented: $confirmDiscard, titleVisibility: .visible) {
                    Button("Discard changes", role: .destructive) { finished(false) }
                    Button("Keep editing", role: .cancel) {}
                }
        }
        .interactiveDismissDisabled(dirty || saving)
    }

    @ViewBuilder private var strip: some View {
        if changed {
            FilesStripView(message: "The file changed since you opened this part. Copy your edits, then read it again.",
                           action: ("Read again", { finished(true) }), secondary: nil, dismiss: nil)
        } else if let problem {
            FilesStripView(message: problem, dismiss: { self.problem = nil })
        }
    }

    private func save() {
        guard !saving else { return }
        saving = true
        problem = nil
        let typed = handle.text
        Task {
            defer { saving = false }
            do {
                let result = try await model.files(scope, ["op": "part.write", "path": path, "offset": part.offset, "length": part.length,
                                                           "text": typed, "version": version], as: FileChange.self)
                if result.conflict != nil { changed = true; return }
                finished(true)
            } catch {
                problem = error.localizedDescription
            }
        }
    }
}
