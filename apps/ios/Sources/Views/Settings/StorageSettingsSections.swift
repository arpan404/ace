import SwiftUI

/// Saves one storage setting (`host.storage.set`); throws the machine's words on refusal.
typealias StorageSave = @MainActor ([String: Any]) async throws -> Void

/// Settled worktrees: delete them automatically after some days, back them up first, or
/// preview deleting every settled one now.
struct StorageWorktreeSection: View {
    let settings: StoragePage.Settings
    let busy: Bool
    let save: StorageSave
    let previewAll: () -> Void
    @State private var problem: String?

    var body: some View {
        Section {
            Toggle("Automatic deletion", isOn: Binding(
                get: { settings.worktreeDays != nil },
                set: { on in write(["key": "worktreeDays", "days": on ? 30 : NSNull()]) }))
                .accessibilityIdentifier("storage.worktrees.auto")
            if let days = settings.worktreeDays {
                NumberRow(title: "Delete after settling", unit: "days", value: days, pinnedBy: nil) { value in
                    try await save(["key": "worktreeDays", "days": value])
                } failed: { problem = $0 }
                .transition(.opacity)
            }
            Toggle("Back up to origin", isOn: Binding(
                get: { settings.backupWorktrees },
                set: { on in write(["key": "backupWorktrees", "on": on]) }))
            Button("Delete all settled worktrees", role: .destructive, action: previewAll)
                .disabled(busy).accessibilityIdentifier("storage.worktrees.deleteAll")
            ServiceProblem(message: problem)
        } header: { InsetHeader("Worktrees") } footer: {
            Text("Automatic deletion only removes clean worktrees merged into origin/main. Back up commits everything not in .gitignore, .env included, and pushes it to origin.")
        }
        .animation(.smooth, value: settings.worktreeDays)
        .sensoryFeedback(.selection, trigger: settings.backupWorktrees)
    }
    private func write(_ setting: [String: Any]) {
        Task {
            do { try await save(setting); problem = nil } catch { problem = error.localizedDescription }
        }
    }
}

/// The host's data window and log cap; a value set by an environment variable can't change here.
struct StorageWindowSection: View {
    let settings: StoragePage.Settings
    let save: StorageSave
    @State private var problem: String?

    var body: some View {
        Section {
            NumberRow(title: "Keep data for", unit: "days", value: settings.retentionDays.value, pinnedBy: settings.retentionDays.pinnedBy) { value in
                try await save(["key": "retentionDays", "days": value])
            } failed: { problem = $0 }
            NumberRow(title: "Log limit", unit: "MB", value: settings.logMegabytes.value, pinnedBy: settings.logMegabytes.pinnedBy) { value in
                try await save(["key": "logMegabytes", "megabytes": value])
            } failed: { problem = $0 }
            ServiceProblem(message: problem)
        } header: { InsetHeader("Data window") } footer: {
            Text("Idle threads, unused attachments and old logs go after this many days. Pinned and live work stays.")
        }
    }
}

/// How long each kind of data is kept; an empty field keeps it.
struct StorageKindsSection: View {
    let settings: StoragePage.Settings
    let save: StorageSave
    @State private var problem: String?

    var body: some View {
        Section {
            ForEach(settings.kinds) { kind in
                NumberRow(title: kind.title, unit: "days", value: kind.days, pinnedBy: nil, subtitle: kind.note, emptyKeeps: true, optional: { value in
                    try await save(["key": "kind", "kind": kind.kind, "days": value ?? NSNull()])
                }, failed: { problem = $0 })
            }
            Toggle("Daily cleanup", isOn: Binding(
                get: { settings.scheduledCleanup },
                set: { on in
                    Task {
                        do { try await save(["key": "scheduledCleanup", "on": on]); problem = nil } catch { problem = error.localizedDescription }
                    }
                }))
                .accessibilityIdentifier("storage.daily")
            ServiceProblem(message: problem)
        } header: { InsetHeader("Retention") } footer: {
            Text("Days to keep archived threads and unused data, by kind. Empty keeps it; pins and live work always stay. Daily cleanup runs every day; worktrees have their own setting.")
        }
        .sensoryFeedback(.selection, trigger: settings.scheduledCleanup)
    }
}

/// A title with a small number field that saves when editing ends.
struct NumberRow: View {
    let title: String
    let unit: String
    let value: Double?
    let pinnedBy: String?
    let subtitle: String?
    /// An empty field saves nil ("keep it") instead of putting the value back.
    let emptyKeeps: Bool
    let commit: @MainActor (Double?) async throws -> Void
    let failed: @MainActor (String?) -> Void
    @State private var draft: String?
    @State private var saving = false
    @FocusState private var focused: Bool

    init(title: String, unit: String, value: Double?, pinnedBy: String?, subtitle: String? = nil, emptyKeeps: Bool = false,
         commit: @escaping @MainActor (Double) async throws -> Void, failed: @escaping @MainActor (String?) -> Void) {
        self.init(title: title, unit: unit, value: value, pinnedBy: pinnedBy, subtitle: subtitle, emptyKeeps: emptyKeeps,
                  optional: { value in if let value { try await commit(value) } }, failed: failed)
    }
    init(title: String, unit: String, value: Double?, pinnedBy: String?, subtitle: String? = nil, emptyKeeps: Bool,
         optional commit: @escaping @MainActor (Double?) async throws -> Void, failed: @escaping @MainActor (String?) -> Void) {
        self.title = title; self.unit = unit; self.value = value; self.pinnedBy = pinnedBy
        self.subtitle = subtitle; self.emptyKeeps = emptyKeeps; self.commit = commit; self.failed = failed
    }

    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                Text(title)
                if let line = pinnedBy.map({ "Set by \($0) on this machine" }) ?? subtitle {
                    Text(line).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                }
            }
            Spacer(minLength: AceTheme.Spacing.sm)
            TextField(emptyKeeps ? "Keep" : "", text: Binding(get: { draft ?? shown }, set: { draft = $0 }))
                .keyboardType(.numberPad)
                .multilineTextAlignment(.trailing)
                .monospacedDigit()
                .frame(width: 64)
                .focused($focused)
                .disabled(pinnedBy != nil || saving)
                .accessibilityLabel("\(title) in \(unit)")
            Text(unit).foregroundStyle(AceTheme.Colours.mutedForeground)
        }
        .frame(minHeight: AceTheme.Dimensions.touchTarget)
        .onChange(of: focused) { _, now in if !now { save() } }
        .onSubmit(save)
    }
    private var shown: String { value.map { String(format: "%.0f", $0) } ?? "" }
    private func save() {
        guard let text = draft?.trimmingCharacters(in: .whitespaces), text != shown else { draft = nil; return }
        let number = Double(text)
        if text.isEmpty, !emptyKeeps { draft = nil; return }
        if !text.isEmpty, number == nil { failed("Enter a number."); return }
        saving = true
        Task {
            defer { saving = false }
            do { try await commit(number); draft = nil; failed(nil) } catch { failed(error.localizedDescription) }
        }
    }
}
