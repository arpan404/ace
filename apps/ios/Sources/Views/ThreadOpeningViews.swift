import SwiftUI

/// Where a thread's rows go before it has any (`ThreadOpening.coversRows`): still bubbles in the
/// shape of a conversation, sitting on the composer as the rows will, with one line under them
/// saying what is happening. A failed connection gives its reason and Retry instead; a wait that
/// runs long says so (`SkeletonPatience`).
struct ConversationSkeleton: View {
    let opening: ThreadOpening
    /// Asks again: the connection when it failed or stalls, else the thread.
    let retry: () -> Void
    var body: some View {
        if case .failed(let reason) = opening {
            ThreadOpeningFailed(reason: reason, retry: retry)
        } else {
            SkeletonPatience(retry: retry) {
                VStack(alignment: .leading, spacing: AceDesign.Space.group) {
                    bubbles
                    if let words = opening.words {
                        Text(words)
                            .aceFont(AceDesign.TextRole.meta)
                            .foregroundStyle(AceDesign.Ink.subtle)
                            .frame(maxWidth: .infinity, alignment: .center)
                    }
                }
                .padding(AceDesign.Space.margin)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(opening.words ?? "Loading conversation")
                .accessibilityIdentifier("transcript.loading")
            }
        }
    }

    /// An answer's lines, the person's bubble, and the start of the next answer.
    private var bubbles: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.group) {
            VStack(alignment: .leading, spacing: AceDesign.Space.row) {
                SkeletonBar(height: 13)
                SkeletonBar(width: 220, height: 13)
            }
            HStack {
                Spacer(minLength: AceDesign.Space.section)
                AceShape.bubble
                    .fill(AceDesign.Surface.fill)
                    .frame(height: AceDesign.Size.tap)
                    .containerRelativeFrame(.horizontal) { width, _ in width * 0.6 }
            }
            VStack(alignment: .leading, spacing: AceDesign.Space.row) {
                SkeletonBar(height: 13)
                SkeletonBar(height: 13)
                SkeletonBar(width: 180, height: 13)
            }
        }
    }
}

/// The thread couldn't open because its machine isn't reachable: why, and Retry.
private struct ThreadOpeningFailed: View {
    let reason: String
    let retry: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            Text(reason)
                .aceFont(AceDesign.TextRole.rowTitle)
                .foregroundStyle(AceDesign.Ink.primary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Retry", action: retry)
                .buttonStyle(.textAction(.prominent))
                .frame(minHeight: AceDesign.Size.tap)
                .accessibilityIdentifier("transcript.opening.retry")
        }
        .padding(AceDesign.Space.margin)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("transcript.opening.failed")
    }
}

/// Kept rows on screen while the machine connects (`ThreadOpening.syncing`): one quiet line over
/// the feed's top, never in the rows' layout, so it comes and goes without moving them.
struct ThreadSyncingLine: View {
    let opening: ThreadOpening
    let retry: () -> Void
    var body: some View {
        if !opening.coversRows, let words = opening.words {
            HStack(spacing: AceDesign.Space.related) {
                Text(words)
                    .aceFont(AceDesign.TextRole.meta)
                    .foregroundStyle(AceDesign.Ink.muted)
                    .lineLimit(2)
                if opening.retries {
                    Button("Retry", action: retry)
                        .buttonStyle(.textAction(.prominent))
                        .accessibilityIdentifier("transcript.syncing.retry")
                }
            }
            .padding(.horizontal, AceDesign.Space.margin)
            .padding(.vertical, AceDesign.Space.tight)
            .frame(minHeight: AceDesign.Size.tap)
            .background(AceDesign.Surface.fill, in: AceShape.capsule)
            .padding(AceDesign.Space.related)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("transcript.syncing")
            .transition(.opacity)
        }
    }
}
