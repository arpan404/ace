import SwiftUI

/// The sheets the thread's ⋯ menu still opens over it: Work and Logs. Changes, Files, Terminal,
/// Browser and Agents are the thread's pages (`ThreadPager`), or the iPad side panel's tabs.
struct ThreadSheetButtons: ViewModifier {
    @Bindable var model: ClientModel
    @Binding var showingWork: Bool
    @Binding var showingLogs: Bool
    @Environment(\.openPullRequest) private var openPull

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: $showingWork) {
                WorkSheet(model: model).environment(\.openPullRequest, openPull).presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showingLogs) {
                NavigationStack {
                    LogsView(model: model)
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { showingLogs = false } } }
                }
                .presentationDetents([.large]).presentationDragIndicator(.visible)
            }
    }
}

extension View {
    func threadSheets(model: ClientModel, thread: ThreadModel, work: Binding<Bool>, logs: Binding<Bool>) -> some View {
        modifier(ThreadSheetButtons(model: model, showingWork: work, showingLogs: logs))
    }
}

extension EnvironmentValues {
    /// Opens a pull request's page on the thread's own stack: its project, number and repository.
    /// The inbox sets it where it pushes thread pages; nil elsewhere, where GitHub opens instead.
    @Entry var openPullRequest: ((String, Int, ForgeRepository?) -> Void)? = nil
}
