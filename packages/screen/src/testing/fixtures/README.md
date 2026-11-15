`h264-deltas.ace-screen` contains 12 64×64 BGRA pictures encoded by the Mac helper's
actual `VideoEncoder.swift` (VideoToolbox hardware H.264): one keyframe and eleven
interdependent deltas. The synthetic picture changes on every input. No screen is captured.

Regenerate from the repo root on macOS:

```sh
mkdir -p /tmp/ace-recording-fixture
cp packages/screen/src/testing/generate-recording-fixture.swift /tmp/ace-recording-fixture/main.swift
swiftc native/screen-helper/VideoEncoder.swift native/screen-helper/StreamPolicy.swift /tmp/ace-recording-fixture/main.swift -o /tmp/ace-recording-fixture/generate
/tmp/ace-recording-fixture/generate packages/screen/src/testing/fixtures/h264-deltas.ace-screen
```

`decode-recording.swift` is a test-only VideoToolbox decoder. It reads complete
recorded access units, creates a decoder from their SPS/PPS, and counts successful
image callbacks after draining. The recording test compares that count with all
fixture inputs pushed synchronously during the first outstanding disk write.
