import SwiftUI

struct ThreadToolsView: View {
    let model: ClientModel
    let thread: ThreadModel
    let openThread: (String) -> Void
    var body: some View {
        ScrollView {
            QuietSection {
            NavigationLink { TerminalView(model: model, threadId: thread.id) } label: { QuietSectionRow { QuietRowText(title: "Terminal"); RowCaret() } }
            NavigationLink { ThreadCatalogView(model: model, threadId: thread.id) } label: { QuietSectionRow { QuietRowText(title: "Skills and commands"); RowCaret() } }
            NavigationLink { ThreadMcpView(model: model, threadId: thread.id) } label: { QuietSectionRow { QuietRowText(title: "MCP servers"); RowCaret() } }
            }.padding(.vertical, AceDesign.Space.related)
        }
        .buttonStyle(.plain)
        .background(AceDesign.Surface.background)
        .toolbar { SheetClose() }
        .navigationTitle("Thread tools").navigationBarTitleDisplayMode(.inline)
    }
}
