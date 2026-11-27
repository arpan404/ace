import AVFAudio
import AudioToolbox
import Foundation

/// Plays the live page's sound on this phone (ADR 0088 › Audio): Opus packets decoded by
/// AudioToolbox into an `AVAudioEngine`, each scheduled against the video by `AudioPlayout`. The
/// audio session (`.playback`) is active only while it is on; turning it off lets the session go.
/// Which packets reach it is the renderer's `AudioGate`. Everything mutable is confined to `queue`.
final class BrowserSoundPlayer: @unchecked Sendable {
    private let queue = DispatchQueue(label: "ace.browser.sound", qos: .userInitiated)
    /// Local time in seconds, on the host clock the engine schedules by.
    private let clock: @Sendable () -> TimeInterval
    private var on = false
    private var engine: AVAudioEngine?
    private var node: AVAudioPlayerNode?
    private var decoder: OpusPacketDecoder?
    private var playout = AudioPlayout()

    init(clock: @escaping @Sendable () -> TimeInterval = { AVAudioTime.seconds(forHostTime: mach_absolute_time()) }) {
        self.clock = clock
    }

    /// Opens or lets go of the audio output. Turning it on comes from the person's tap.
    func set(_ value: Bool) {
        queue.async { [self] in
            guard value != on else { return }
            on = value
            if value { activate() } else { release() }
        }
    }
    /// A picture captured at `timestamp` (stream ms) is on screen now; tracked while off too, so
    /// turning the sound on starts in step.
    func shown(timestamp: Double) {
        let now = clock() * 1000
        queue.async { [self] in playout.shown(timestamp: timestamp, at: now) }
    }
    /// The stream started over: what is scheduled of the old one goes, and its timing.
    func restart() {
        queue.async { [self] in
            playout.reset()
            decoder = nil
            guard on, let node else { return }
            node.stop()
            node.play()
        }
    }
    /// One packet the renderer's gate let through.
    func play(_ chunk: BrowserAudioChunk) {
        queue.async { [self] in
            guard on, chunk.codec == "opus" else { return }
            if decoder?.matches(chunk) != true { decoder = OpusPacketDecoder(sampleRate: chunk.sampleRate, channels: chunk.channels) }
            guard let decoder, let sound = decoder.decode(chunk.bytes), let node = ready(decoder.output) else { return }
            let duration = Double(sound.frameLength) / decoder.output.sampleRate * 1000
            let now = clock() * 1000
            guard let at = playout.schedule(timestamp: chunk.timestamp, duration: duration, now: now) else { return }
            // The output's own latency: started earlier by it, the sound is heard at `at`.
            let latency = AVAudioSession.sharedInstance().outputLatency
            let start = max(now / 1000, at / 1000 - latency)
            node.scheduleBuffer(sound, at: AVAudioTime(hostTime: AVAudioTime.hostTime(forSeconds: start)), options: [], completionHandler: nil)
        }
    }

    private func activate() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .moviePlayback)
        try? session.setActive(true)
    }
    private func release() {
        node?.stop()
        engine?.stop()
        node = nil; engine = nil; decoder = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    /// The engine running with its player in `format`, made or restarted as needed (an interruption
    /// or route change stops it).
    private func ready(_ format: AVAudioFormat) -> AVAudioPlayerNode? {
        if let engine, let node, node.outputFormat(forBus: 0) == format {
            if !engine.isRunning { try? engine.start() }
            if engine.isRunning, !node.isPlaying { node.play() }
            return engine.isRunning ? node : nil
        }
        node?.stop(); engine?.stop()
        let engine = AVAudioEngine(), node = AVAudioPlayerNode()
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: format)
        do { try engine.start() } catch { return nil }
        node.play()
        self.engine = engine
        self.node = node
        return node
    }
}

/// One Opus stream's packets to PCM, one packet at a time (AudioToolbox's Opus decoder).
private final class OpusPacketDecoder {
    let output: AVAudioFormat
    private let input: AVAudioFormat
    private let converter: AVAudioConverter
    private let sampleRate: Int
    private let channels: Int
    /// The most one Opus packet holds: 120 ms.
    private let capacity: AVAudioFrameCount

    init?(sampleRate: Int, channels: Int) {
        // Opus always decodes at one of its own rates; the capture's rate is kept when it is one.
        let rate = [8_000, 12_000, 16_000, 24_000, 48_000].contains(sampleRate) ? Double(sampleRate) : 48_000
        var description = AudioStreamBasicDescription(
            mSampleRate: rate, mFormatID: kAudioFormatOpus, mFormatFlags: 0, mBytesPerPacket: 0,
            mFramesPerPacket: UInt32(rate / 50), mBytesPerFrame: 0, mChannelsPerFrame: UInt32(channels),
            mBitsPerChannel: 0, mReserved: 0)
        guard let input = AVAudioFormat(streamDescription: &description),
              let output = AVAudioFormat(standardFormatWithSampleRate: rate, channels: AVAudioChannelCount(channels)),
              let converter = AVAudioConverter(from: input, to: output) else { return nil }
        self.input = input
        self.output = output
        self.converter = converter
        self.sampleRate = sampleRate
        self.channels = channels
        capacity = AVAudioFrameCount(rate * 0.12)
    }

    func matches(_ chunk: BrowserAudioChunk) -> Bool { chunk.sampleRate == sampleRate && chunk.channels == channels }

    func decode(_ bytes: Data) -> AVAudioPCMBuffer? {
        let packet = AVAudioCompressedBuffer(format: input, packetCapacity: 1, maximumPacketSize: bytes.count)
        let copied = bytes.withUnsafeBytes { raw -> Bool in
            guard let base = raw.baseAddress else { return false }
            packet.data.copyMemory(from: base, byteCount: raw.count)
            return true
        }
        guard copied, let descriptions = packet.packetDescriptions,
              let sound = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { return nil }
        descriptions.pointee = AudioStreamPacketDescription(mStartOffset: 0, mVariableFramesInPacket: 0, mDataByteSize: UInt32(bytes.count))
        packet.packetCount = 1
        packet.byteLength = UInt32(bytes.count)
        let feed = OnePacket(packet)
        var error: NSError?
        let status = converter.convert(to: sound, error: &error) { _, state in
            guard let packet = feed.take() else { state.pointee = .noDataNow; return nil }
            state.pointee = .haveData
            return packet
        }
        guard status != .error, sound.frameLength > 0 else { return nil }
        return sound
    }
}

/// The converter's input, handed over once: the packet, then no more data for now.
private final class OnePacket: @unchecked Sendable {
    private var packet: AVAudioCompressedBuffer?
    init(_ packet: AVAudioCompressedBuffer) { self.packet = packet }
    func take() -> AVAudioCompressedBuffer? {
        defer { packet = nil }
        return packet
    }
}
