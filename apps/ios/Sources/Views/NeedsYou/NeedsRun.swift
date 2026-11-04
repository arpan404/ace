import SwiftUI

/// The needs-you run: every request waiting on the person across machines, one per page, in the
/// inbox's order. "1 of 3" with a slim track, Skip, and a swipe to move on; each page gives the
/// context to decide (who asks for what, the command, the agent's last words, the thread) and
/// Deny / Allow once as capsules in thumb reach. Questions, plans and forms answer on the
/// thread's own cards. A haptic per decision; requests arriving meanwhile join at the end. It
/// ends on "Nothing needs you" only when nothing waits and no answer is still on its way.
struct NeedsRun: View {
    let inbox: MachineInbox
    /// What waits now, in the list's order.
    let live: () -> [NeedsRunQueue.Entry]
    let openThread: (InboxKey) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.aceReduceMotion) private var reduceMotion
    @State private var queue = NeedsRunQueue()
    @State private var decisions = 0
    @State private var forward = true
    /// The pages are read once, when the run opens; after that requests only join.
    @State private var started = false

    var body: some View {
        let live = live()
        NavigationStack {
            VStack(spacing: AceTheme.Spacing.none) {
                NeedsRunTrack(progress: queue.progress)
                Group {
                    if let entry = queue.current, let model = inbox.client(entry.thread.machineId), let request = request(entry) {
                        NeedsRunPage(entry: entry, request: request, model: model, row: inbox.row(entry.thread),
                                     machine: inbox.showsMachineNames ? inbox.name(entry.thread.machineId) : nil,
                                     openThread: { openThread(entry.thread) }, decided: decided)
                            .id(entry)
                            .transition(pageTransition)
                    } else {
                        end(live)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .contentShape(Rectangle())
                .simultaneousGesture(swipe)
            }
            .background(AceDesign.Surface.background)
            .navigationTitle(queue.atEnd ? "" : "\(queue.index + 1) of \(queue.pages.count)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Close").accessibilityIdentifier("run.close")
                }
                if !queue.atEnd {
                    ToolbarItem(placement: .primaryAction) {
                        Button("Skip") { move { $0.next(open: isOpen) } }
                            .accessibilityIdentifier("run.skip")
                    }
                }
            }
        }
        .sensoryFeedback(AceDesign.Haptic.approve, trigger: decisions)
        .onAppear {
            guard !started else { return }
            started = true
            queue = NeedsRunQueue(live)
            queue.skipClosed(open: isOpen)
        }
        .onChange(of: live) { _, now in
            queue.merge(now)
            withAnimation(AceDesign.Motion.arriving(reduceMotion)) { queue.skipClosed(open: isOpen) }
        }
    }

    private func request(_ entry: NeedsRunQueue.Entry) -> ApprovalRow? {
        inbox.client(entry.thread.machineId)?.needsYou(entry.thread.id).first { $0.id == entry.request }
    }
    /// Still waiting, with no answer on its way.
    private func isOpen(_ entry: NeedsRunQueue.Entry) -> Bool {
        guard request(entry) != nil else { return false }
        return inbox.client(entry.thread.machineId)?.approvalSubmissions[entry.request] == nil
    }
    private func decided() {
        decisions += 1
        move { $0.next(open: isOpen) }
    }
    private func move(forward: Bool = true, _ change: (inout NeedsRunQueue) -> Void) {
        self.forward = forward
        withAnimation(AceDesign.Motion.arriving(reduceMotion)) { change(&queue) }
    }
    private var pageTransition: AnyTransition {
        reduceMotion ? .opacity : .asymmetric(insertion: .move(edge: forward ? .trailing : .leading).combined(with: .opacity),
                                              removal: .move(edge: forward ? .leading : .trailing).combined(with: .opacity))
    }
    /// Left for the next page, right for the one before.
    private var swipe: some Gesture {
        DragGesture(minimumDistance: 24).onEnded { drag in
            guard abs(drag.translation.width) > abs(drag.translation.height) * 2, abs(drag.translation.width) > 60 else { return }
            if drag.translation.width < 0 { if !queue.atEnd { move { $0.next(open: isOpen) } } } else { move(forward: false) { $0.back() } }
        }
    }

    @ViewBuilder private func end(_ live: [NeedsRunQueue.Entry]) -> some View {
        let waiting = live.filter(isOpen)
        switch NeedsRunQueue.end(waiting: waiting.count, sending: live.count - waiting.count) {
        case .nothing:
            EmptyState(systemImage: "checkmark.circle", title: "Nothing needs you") {
                Button("Done") { dismiss() }.accessibilityIdentifier("run.done")
            }
            .padding(.top, AceDesign.Space.section * 2)
        case .sending(let count):
            EmptyState(systemImage: "arrow.up.circle", title: count == 1 ? "Sending your answer" : "Sending your answers",
                       line: "This clears once your machine has them.") {
                Button("Done") { dismiss() }.accessibilityIdentifier("run.done")
            }
            .padding(.top, AceDesign.Space.section * 2)
        case .remaining(let count):
            EmptyState(systemImage: "hand.raised", title: count == 1 ? "1 still needs you" : "\(count) still need you") {
                Button("Review") { move { $0.again(waiting) } }.accessibilityIdentifier("run.again")
            }
            .padding(.top, AceDesign.Space.section * 2)
        }
    }
}

/// The run's progress: a hairline-slim capsule filled in ink as pages are done.
private struct NeedsRunTrack: View {
    let progress: Double
    var body: some View {
        GeometryReader { box in
            Capsule().fill(AceDesign.Surface.fill)
                .overlay(alignment: .leading) {
                    Capsule().fill(AceTheme.Colours.mutedForeground).frame(width: box.size.width * progress)
                }
        }
        .frame(height: AceDesign.Size.runTrack)
        .padding(.horizontal, AceDesign.Space.margin)
        .padding(.vertical, AceDesign.Space.related)
        .accessibilityElement()
        .accessibilityLabel("Progress")
        .accessibilityValue("\(Int((progress * 100).rounded())) percent")
    }
}
