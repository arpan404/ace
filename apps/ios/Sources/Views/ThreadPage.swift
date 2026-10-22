import SwiftUI

/// One pushed thread page. The client shows one thread at a time, but a navigation stack keeps
/// several pages: the parent under a child, and the page sliding away while the client already
/// moved on. Each page keeps the thread it last drew, so it stays whole while it is uncovered by
/// a swipe back or slides off, and takes the client's thread again whenever that is this one.
struct ThreadPage: View {
    let client: ClientModel
    let id: String
    let openThread: (String) -> Void
    @State private var kept: ThreadModel?
    private var live: ThreadModel? { client.thread.flatMap { $0.id == id ? $0 : nil } }

    var body: some View {
        if let thread = live ?? kept {
            ThreadView(model: client, thread: thread, openThread: openThread)
                .onChange(of: ObjectIdentifier(thread), initial: true) { kept = thread }
        }
    }
}
