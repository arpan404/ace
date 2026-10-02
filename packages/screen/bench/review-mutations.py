"""Non-gating behavior mutations; restore production bytes even when a probe fails."""
import json
import os
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[3]
mutations = [
    (6, "cancel queued input before permission inspection", "packages/screen/src/manager.ts", '        if (session.epoch !== epoch) throw new Error("Controller changed");', '', 'packages/screen/src/manager.test.ts', 'human takeover cancels queued'),
    (8, "disable terminates owned captures", "packages/screen/src/manager.ts", '    if (!enabled) await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));', '', 'packages/screen/src/shutdown.test.ts', 'disabling and revoking'),
    (14, "unsubscribe removes an active viewer", "packages/screen/src/frames.ts", '      subscriber.active = false;\n      subscriber.pending = undefined;\n      this.subscribers.delete(subscriber);', '', 'packages/screen/src/frames.test.ts', 'unsubscribe discards'),
    (22, "reversed helper replies correlate by id", "packages/screen/src/helper.ts", 'const pending = this.pending.get(reply.id);', 'const pending = this.pending.values().next().value;', 'packages/screen/src/helper.test.ts', 'correlates concurrent'),
    (24, "advertised text limit matches accepted input", "packages/screen/src/tools.ts", 'const Type = TypeAction.omit({ kind: true });', 'const Type = TypeAction.omit({ kind: true }).extend({ text: z.string().max(8192) });', 'packages/screen/src/tools.test.ts', 'advertised text schema'),
    (31, "newline-free output is bounded before accumulation", "packages/screen/src/helper.ts", '        maxLineBytes: 64 * 1024,', '', 'packages/screen/src/output-limit.test.ts', 'oversized stdout'),
    (32, "indicator remains visible during termination", "packages/screen/src/policy.ts", 'return { ...state, lifecycle: "stopping", controller: "none" };', 'return { ...state, lifecycle: "stopping", controller: "none", indicator: false };', 'packages/screen/src/shutdown.test.ts', 'indicator remains on'),
    (33, "capture closes independently of publication", "packages/screen/src/manager.ts", '    await session.helper.close();\n    session.state = terminated(session.state);', '    if (session.recording) await this.stopRecording(session.state.sessionId);\n    await session.helper.close();\n    session.state = terminated(session.state);', 'packages/screen/src/shutdown.test.ts', 'stalled recording publisher'),
    (34, "helper deadlines fail outstanding work", "packages/screen/src/helper.ts", '() => this.fail(new Error("Helper command timed out"))', '() => {}', 'packages/screen/src/helper.test.ts', 'injected command deadline'),
]
if os.environ.get('ACE_SCREEN_MUTATE_NATIVE') == '1':
    mutations = [
        (29, "decoded capture contains fixture pixels", "native/screen-helper/JPEGEncoder.swift", 'let ciImage = CIImage(cvPixelBuffer: image)', 'let ciImage = CIImage(color: .black).cropped(to: CIImage(cvPixelBuffer: image).extent)', 'packages/screen/src/native.test.ts', 'macOS captures'),
        (30, "window target input changes the fixture", "native/screen-helper/Input.swift", '        var location = CGPoint.zero', '        if target.kind == "window" { return }\n        var location = CGPoint.zero', 'packages/screen/src/native.test.ts', 'macOS captures'),
        (35, "overlapping application windows cannot receive captured-window input", "native/screen-helper/Input.swift", 'guard !candidates.contains(where: { $0.windowID != window.windowID && $0.frame.contains(location) })', 'guard true', 'packages/screen/src/native.test.ts', 'macOS captures'),
    ]
results = []
for number, name, path, before, after, test, title in mutations:
    production = root / path
    original = production.read_text()
    if before not in original:
        raise RuntimeError(f'Mutation {number} anchor missing')
    try:
        production.write_text(original.replace(before, after, 1))
        env = dict(os.environ)
        if number in (29, 30, 35):
            env['ACE_SCREEN_INTEGRATION'] = '1'
        result = subprocess.run(['bun', 'run', 'test', test, '-t', title], cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        killed = result.returncode != 0 and ('AssertionError' in result.stdout or 'Test timed out' in result.stdout)
        results.append({'reviewMutation': number, 'behavior': name, 'killed': killed})
        print(json.dumps(results[-1]), flush=True)
        if not killed:
            print(result.stdout)
            raise RuntimeError(f'Mutation {number} survived or probe failed without a behavior assertion')
    finally:
        production.write_text(original)
output = root / 'packages/screen/bench' / ('review-native-mutation-results.json' if os.environ.get('ACE_SCREEN_MUTATE_NATIVE') == '1' else 'review-mutation-results.json')
output.write_text(json.dumps(results, indent=2) + '\n')
