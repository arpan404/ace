// SPDX-License-Identifier: Apache-2.0
// Manual decode check of recorded parts on macOS, with no external tools:
//   ACE_MEDIA_PLAYBACK_DIR=/tmp/ace-rec cargo test -p ace-media --test recording -- --test-threads=1
//   swift crates/ace-media/tests/playback.swift /tmp/ace-rec
// Each part must decode every video sample it holds, and its audio when it has a track.
import AVFoundation
import Foundation

let directory = CommandLine.arguments[1]
let names = try FileManager.default.contentsOfDirectory(atPath: directory)
    .filter { $0.hasSuffix(".mp4") }.sorted()
guard !names.isEmpty else { fatalError("no parts in \(directory)") }
for name in names {
    let asset = AVURLAsset(url: URL(fileURLWithPath: directory + "/" + name))
    let reader = try AVAssetReader(asset: asset)
    let video = asset.tracks(withMediaType: .video)[0]
    let pictures = AVAssetReaderTrackOutput(
        track: video,
        outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    reader.add(pictures)
    var sound: AVAssetReaderTrackOutput?
    if let audio = asset.tracks(withMediaType: .audio).first {
        let output = AVAssetReaderTrackOutput(
            track: audio, outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM])
        reader.add(output)
        sound = output
    }
    guard reader.startReading() else { fatalError("\(name): \(String(describing: reader.error))") }
    var frames = 0
    while let sample = pictures.copyNextSampleBuffer() {
        guard CMSampleBufferGetImageBuffer(sample) != nil else { fatalError("\(name): not decoded") }
        frames += 1
    }
    var pcm = 0
    while let buffer = sound?.copyNextSampleBuffer() {
        pcm += CMSampleBufferGetNumSamples(buffer)
    }
    guard reader.status == .completed, frames > 0 else {
        fatalError("\(name): \(frames) frames: \(String(describing: reader.error))")
    }
    print("\(name): decoded \(frames) frames, \(pcm) PCM samples")
}
