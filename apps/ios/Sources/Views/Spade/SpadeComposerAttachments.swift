import SwiftUI

/// The foot of a Spade conversation (docs/design/spade.md §3): the field, with the thread
/// composer's attach menu before it (Photo library, Camera, Files) and its strip of picked files
/// above it, each with Remove. While the field is empty and nothing is attached the mic stands in
/// Send's place: hold to record a voice message, which then waits above the field to be sent or
/// discarded. Stop takes Send's place while a reply is open and nothing is ready to go. Spade's
/// limits are the bridge's to check; a refused message gives its words and files back.
struct SpadeComposer: View {
    let name: String
    /// A reply is open: Stop shows while nothing is ready to send.
    let answering: Bool
    /// Files and voice go with the message (a bot's chat); a group's takes words only.
    let attaches: Bool
    /// The recorder starts as the composer shows (Talk to Spade).
    var records = false
    @Binding var problem: String?
    /// Words the profile asked to quote into the field (a decision's Change); taken once, then nil.
    var quoted: Binding<String?> = .constant(nil)
    /// Spade's answer to one message.
    let send: (SpadeComposerPicks.Outgoing) async -> SpadeOutcome
    /// A message went: the chat shows its end.
    let sent: () -> Void
    let stop: () -> Void
    @State private var draft = ""
    @State private var picks = SpadeComposerPicks()
    @State private var recorder = SpadeVoiceRecorder()
    @State private var recordedAtOnce = false
    /// Why the last pick couldn't be read (`AttachMenu`).
    @State private var pickProblem: String?
    @FocusState private var typing: Bool
    @Environment(\.openURL) private var openURL
    private let staging = AttachmentStaging()

    var body: some View {
        let rowInset = AceDesign.Space.tight
        let textInset = attaches ? AceDesign.Space.tight : AceDesign.Space.margin
        let attachWidth = attaches ? AceDesign.Size.tap + AceDesign.Space.tight : 0
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            notice
            if recorder.recording, let began = recorder.began {
                SpadeRecordingLine(began: began)
            } else if let voice = picks.voice {
                SpadeRecordedLine(seconds: voice.seconds, sending: picks.sending) { remove(voice.file.localId) }
            }
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                if !picks.files.isEmpty {
                    ComposerMediaStrip(files: picks.strip, staging: staging, inset: rowInset + attachWidth + textInset, remove: remove)
                        .accessibilityIdentifier("spade.attachments")
                }
                HStack(alignment: .bottom, spacing: AceDesign.Space.tight) {
                    if attaches {
                        AttachMenu(stage: { picks.add($0) }, problem: $pickProblem, identifier: "spade.attach", staging: staging)
                            .disabled(picks.sending || recorder.recording)
                    }
                    TextField("Message \(name)", text: $draft, axis: .vertical)
                        .aceFont(AceDesign.TextRole.message)
                        .lineLimit(1...6)
                        .focused($typing)
                        .padding(.horizontal, textInset)
                        .padding(.vertical, AceDesign.Space.related)
                        .accessibilityIdentifier("spade.composer")
                    trailing
                }
                .padding(rowInset)
            }
            .aceGlass(in: AceDesign.Shape.field, interactive: true)
            .padding(.horizontal, AceDesign.Space.margin)
            .padding(.bottom, AceDesign.Space.related)
        }
        .onDisappear { recorder.cancel() }
        // Once: coming back to this chat from another doesn't record again.
        .task {
            guard records, !recordedAtOnce else { return }
            recordedAtOnce = true
            await recorder.start()
        }
        .onChange(of: quoted.wrappedValue, initial: true) { _, quote in
            guard let quote else { return }
            draft = SpadeQuote.into(draft, quote: quote)
            quoted.wrappedValue = nil
            typing = true
        }
    }

    /// One line above the field: Spade's refusal, a pick that couldn't be read, or why the
    /// microphone can't record, with Settings when that's where it is allowed.
    @ViewBuilder private var notice: some View {
        if let text = problem ?? pickProblem ?? recorder.problem?.text {
            HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.related) {
                Text(text)
                    .aceFont(AceDesign.TextRole.meta)
                    .foregroundStyle(AceTheme.StatusText.failed)
                    .accessibilityIdentifier("spade.problem")
                if problem == nil, pickProblem == nil, recorder.problem?.settings == true {
                    Button("Open Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                    }
                    .aceFont(AceDesign.TextRole.meta)
                    .accessibilityIdentifier("spade.micSettings")
                }
            }
            .padding(.horizontal, AceDesign.Space.margin)
        }
    }

    /// Send once something is ready (a message steers an open reply); Stop while a reply is open
    /// and nothing is; the mic while the field and the strip are empty.
    @ViewBuilder private var trailing: some View {
        if !picks.canSend(draft) && !picks.sending && answering && !recorder.recording {
            Button { stop() } label: {
                RoundedRectangle(cornerRadius: AceDesign.Corner.glyphStop)
                    .frame(width: AceDesign.Size.stopGlyph, height: AceDesign.Size.stopGlyph)
                    .foregroundStyle(AceDesign.Surface.background)
                    .frame(width: AceDesign.Size.navButton, height: AceDesign.Size.navButton)
                    .background(AceDesign.Ink.accent, in: Circle())
            }
            .accessibilityLabel("Stop")
            .accessibilityIdentifier("spade.stop")
        } else if attaches && (picks.offersMic(draft) || recorder.recording) {
            SpadeMicButton(recorder: recorder) { take in
                pickProblem = nil
                if let old = picks.record(take) { staging.discard(old.localId) }
            }
        } else {
            let ready = picks.canSend(draft)
            Button { go() } label: {
                AceIcon(.arrowUp, size: AceDesign.Size.icon, relativeTo: .body)
                    .foregroundStyle(AceDesign.Surface.background)
                    .frame(width: AceDesign.Size.navButton, height: AceDesign.Size.navButton)
                    .background(ready ? AceDesign.Ink.accent : AceDesign.Ink.faint, in: Circle())
            }
            .disabled(!ready)
            .accessibilityLabel("Send")
            .accessibilityIdentifier("spade.send")
        }
    }

    private func remove(_ localId: String) {
        if let gone = picks.remove(localId) { staging.discard(gone.localId) }
    }

    private func go() {
        guard let out = picks.send(draft) else { return }
        draft = ""
        problem = nil
        pickProblem = nil
        recorder.clearProblem()
        sent()
        Task {
            let outcome = await send(out)
            for file in picks.answered(ok: outcome.ok) { staging.discard(file.localId) }
            guard !outcome.ok else { return }
            // Refused: the words come back, before anything typed while it was out; the files
            // are still in the strip.
            if !out.text.isEmpty { draft = SpadeDraft.restoring(out.text, into: draft) }
            problem = outcome.problem
        }
    }
}

/// While the mic is held: the running length, and how to drop it.
private struct SpadeRecordingLine: View {
    let began: Date
    var body: some View {
        TimelineView(.periodic(from: began, by: 1)) { context in
            HStack(spacing: AceDesign.Space.related) {
                AceIcon(.record, size: AceDesign.Size.glyphSmall, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.StatusText.failed)
                Text("Recording \(SpadeComposerPicks.length(context.date.timeIntervalSince(began)))")
                    .monospacedDigit()
                    .foregroundStyle(AceDesign.Ink.primary)
                Text("· Slide away to cancel").foregroundStyle(AceDesign.Ink.muted)
            }
            .aceFont(AceDesign.TextRole.meta)
        }
        .padding(.horizontal, AceDesign.Space.margin)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("spade.recording")
    }
}

/// A recording waiting to go with the message: its length, and Discard.
private struct SpadeRecordedLine: View {
    let seconds: Double
    let sending: Bool
    let discard: () -> Void
    var body: some View {
        HStack(spacing: AceDesign.Space.related) {
            AceIcon(.microphone, size: AceDesign.Size.glyphSmall, relativeTo: .footnote)
                .foregroundStyle(AceDesign.Ink.muted)
            Text("Voice message \(SpadeComposerPicks.length(seconds))")
                .aceFont(AceDesign.TextRole.meta).monospacedDigit()
                .foregroundStyle(AceDesign.Ink.primary)
            Spacer(minLength: AceTheme.Spacing.none)
            Button(action: discard) {
                AceIcon(.trash, size: AceDesign.Size.icon, relativeTo: .footnote)
                    .foregroundStyle(AceDesign.Ink.muted)
                    .frame(width: AceDesign.Size.tap, height: AceDesign.Size.tap)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(sending)
            .accessibilityLabel("Discard voice message")
            .accessibilityIdentifier("spade.voice.discard")
        }
        .opacity(sending ? AceTheme.Opacity.disabled(.light) : 1)
        .padding(.leading, AceDesign.Space.margin)
        .padding(.trailing, AceDesign.Space.tight)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("spade.voice")
    }
}
