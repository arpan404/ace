import Observation
import SwiftUI

/// A change the Files screens ask for: a name to type, or a delete to confirm.
enum FilePrompt: Identifiable, Equatable {
    case create(folder: String)
    case mkdir(folder: String)
    case rename(path: String)
    case move(path: String)
    case delete(path: String)
    var id: String {
        switch self {
        case .create(let folder): "create:\(folder)"
        case .mkdir(let folder): "mkdir:\(folder)"
        case .rename(let path): "rename:\(path)"
        case .move(let path): "move:\(path)"
        case .delete(let path): "delete:\(path)"
        }
    }
    var title: String {
        switch self {
        case .create: "New file"
        case .mkdir: "New folder"
        case .rename: "Rename"
        case .move: "Move"
        case .delete: "Delete"
        }
    }
    var isDelete: Bool { if case .delete = self { true } else { false } }
    /// The sentence a refusal starts with: its own verb, and for something new the name typed.
    func failure(typed: String) -> String {
        switch self {
        case .create: "Couldn't create \(FileActions.name(typed))."
        case .mkdir: "Couldn't create the folder \(FileActions.name(typed))."
        case .rename(let path): "Couldn't rename \(FileActions.name(path))."
        case .move(let path): "Couldn't move \(FileActions.name(path))."
        case .delete(let path): "Couldn't delete \(FileActions.name(path))."
        }
    }
    /// What the text field starts with: the folder to add to, or the path being changed.
    var start: String {
        switch self {
        case .create(let folder), .mkdir(let folder): folder
        case .rename(let path), .move(let path), .delete(let path): path.hasSuffix("/") ? String(path.dropLast()) : path
        }
    }
}

/// One plain sentence under the files, with at most one verb.
struct FileStrip: Equatable {
    let id = UUID()
    let message: String
    /// "Undo" restores what was just deleted.
    var undo: (trashId: String, path: String)?
    static func == (a: FileStrip, b: FileStrip) -> Bool { a.id == b.id }
}

/// Create, rename, move and delete for a thread's checkout, with the web's checks and wording:
/// renames stay in their folder, deletes go to Recently deleted and can be undone at once.
@MainActor @Observable final class FileActions {
    var prompt: FilePrompt?
    var text = ""
    var strip: FileStrip?
    var busy = false
    @ObservationIgnored let model: ClientModel
    @ObservationIgnored let scope: FilesScope
    /// A change landed (its prompt; nil for an undone delete): the path it changed and, for a
    /// rename or move, where it went now.
    @ObservationIgnored var changed: (FilePrompt?, FileChange) -> Void = { _, _ in }

    init(model: ClientModel, scope: FilesScope) {
        self.model = model
        self.scope = scope
    }
    var canChange: Bool { scope.changes && model.canOperate }

    func ask(_ prompt: FilePrompt) {
        text = prompt.start
        self.prompt = prompt
    }

    func submit(_ prompt: FilePrompt) {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let operation: [String: Any]
        switch prompt {
        case .create: operation = ["op": "create", "path": value]
        case .mkdir: operation = ["op": "mkdir", "path": value]
        case .rename(let path): operation = ["op": "rename", "path": path, "destination": value]
        case .move(let path): operation = ["op": "move", "path": path, "destination": value]
        case .delete(let path): operation = ["op": "delete", "path": path]
        }
        guard !busy, prompt.isDelete || !value.isEmpty else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                let change = try await model.files(scope, operation, as: FileChange.self)
                if case .delete(let path) = prompt, let trashId = change.trashId {
                    strip = FileStrip(message: "Deleted \(Self.name(path)).", undo: (trashId, path))
                } else { strip = nil }
                changed(prompt, change)
            } catch {
                strip = FileStrip(message: "\(prompt.failure(typed: value)) \(error.localizedDescription)")
            }
        }
    }

    func undo() {
        guard let undo = strip?.undo else { return }
        strip = nil
        Task {
            do {
                let change = try await model.files(scope, ["op": "restore", "trashId": undo.trashId, "path": undo.path], as: FileChange.self)
                changed(nil, change)
            } catch {
                strip = FileStrip(message: "Couldn't restore \(Self.name(undo.path)). \(error.localizedDescription)")
            }
        }
    }

    nonisolated static func name(_ path: String) -> String {
        let clean = path.hasSuffix("/") ? String(path.dropLast()) : path
        return clean.split(separator: "/").last.map(String.init) ?? clean
    }
}

/// The prompts and the strip, attached once to a Files screen.
struct FileActionPrompts: ViewModifier {
    @Bindable var actions: FileActions

    func body(content: Content) -> some View {
        content
            .alert(actions.prompt?.title ?? "", isPresented: textPrompt, presenting: actions.prompt) { prompt in
                TextField(prompt.title == "Move" ? "Destination path" : "Path", text: $actions.text)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityIdentifier("files.prompt.field")
                Button("Cancel", role: .cancel) {}
                Button(prompt.title == "New file" || prompt.title == "New folder" ? "Create" : prompt.title) { actions.submit(prompt) }
                    .accessibilityIdentifier("files.prompt.submit")
            }
            .alert(actions.prompt.map { "Delete \(FileActions.name($0.start))?" } ?? "", isPresented: deletePrompt, presenting: actions.prompt) { prompt in
                Button("Cancel", role: .cancel) {}
                Button("Delete", role: .destructive) { actions.submit(prompt) }.accessibilityIdentifier("files.delete.confirm")
            } message: { _ in
                Text("It moves to Recently deleted, where you can restore it.")
            }
            .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) {
                if let strip = actions.strip {
                    FilesStripView(message: strip.message, action: strip.undo == nil ? nil : ("Undo", { actions.undo() }),
                                   dismiss: { actions.strip = nil })
                        .task(id: strip.id) {
                            // An undo stays offered for a few seconds, as the web's toast does.
                            guard strip.undo != nil else { return }
                            try? await Task.sleep(for: .seconds(6))
                            if actions.strip == strip { actions.strip = nil }
                        }
                }
            }
    }
    private var textPrompt: Binding<Bool> {
        Binding(get: { actions.prompt.map { !$0.isDelete } ?? false }, set: { if !$0 { actions.prompt = nil } })
    }
    private var deletePrompt: Binding<Bool> {
        Binding(get: { actions.prompt?.isDelete ?? false }, set: { if !$0 { actions.prompt = nil } })
    }
}

/// One plain sentence and text buttons, floating over the bottom of a Files screen.
struct FilesStripView: View {
    let message: String
    var action: (String, () -> Void)?
    var secondary: (String, () -> Void)?
    let dismiss: (() -> Void)?
    var body: some View {
        HStack(spacing: AceTheme.Spacing.md) {
            Text(message).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                .foregroundStyle(AceTheme.Colours.foreground)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("files.strip")
            if let action {
                Button(action.0, action: action.1).fontWeight(.semibold).accessibilityIdentifier("files.strip.action")
            }
            if let secondary { Button(secondary.0, action: secondary.1) }
            if let dismiss, action == nil, secondary == nil { Button("Dismiss", action: dismiss) }
        }
        .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
        .foregroundStyle(AceTheme.Colours.foreground)
        .padding(.horizontal, AceTheme.Spacing.lg).frame(minHeight: AceTheme.Dimensions.touchTarget)
        .floatingGlass()
        .padding(.horizontal, AceTheme.Spacing.md).padding(.bottom, AceTheme.Spacing.sm)
        .transition(.opacity)
    }
}
