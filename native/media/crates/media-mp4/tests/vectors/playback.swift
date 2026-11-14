// SPDX-License-Identifier: Apache-2.0
// Manual native decode smoke: swift playback.swift /path/to/exported/files
import Foundation
import AVFoundation
import CoreVideo

let directory = CommandLine.arguments[1]
for codec in ["h264", "hevc"] {
    for (suffix, expected) in [("", 3), ("-cut", 2)] {
        let asset = AVURLAsset(url: URL(fileURLWithPath: directory + "/" + codec + suffix + ".mp4"))
        let reader = try AVAssetReader(asset: asset)
        let track = asset.tracks(withMediaType: .video)[0]
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        reader.add(output)
        guard reader.startReading() else { fatalError("cannot start: \(String(describing: reader.error))") }
        var frames = 0
        while let sample = output.copyNextSampleBuffer() {
            guard CMSampleBufferGetImageBuffer(sample) != nil else { fatalError("not decoded") }
            frames += 1
        }
        guard frames == expected else { fatalError("\(codec)\(suffix): \(frames) frames, expected \(expected): \(String(describing: reader.error))") }
        print("\(codec)\(suffix): decoded \(frames) frames")
    }
}

// The six 20 ms silence packets end with only 119 valid PCM samples.
let audioAsset = AVURLAsset(url: URL(fileURLWithPath: directory + "/opus-cut.mp4"))
let audioReader = try AVAssetReader(asset: audioAsset)
let audioTrack = audioAsset.tracks(withMediaType: .audio)[0]
let audioOutput = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM])
audioReader.add(audioOutput)
guard audioReader.startReading() else { fatalError("cannot start audio: \(String(describing: audioReader.error))") }
// AVAssetReader returns whole decoded packets here, without applying the tail
// trim. The Rust reader test verifies the stored final duration of 119 ticks.
var pcmSamples = 0
while let buffer = audioOutput.copyNextSampleBuffer() {
    pcmSamples += CMSampleBufferGetNumSamples(buffer)
}
guard audioReader.status == .completed, pcmSamples == 5760 else {
    fatalError("Opus: \(pcmSamples) PCM samples, expected 5760: \(String(describing: audioReader.error))")
}
print("opus-cut: decoded \(pcmSamples) PCM samples")
