#!/usr/bin/env python3
"""Run named behavioral mutations sequentially, restoring source even after failure."""
from pathlib import Path
import subprocess
import json
import sys

mutations = [
    ('login disabled', 'packages/service/src/plan.ts', '<key>RunAtLoad</key><true/>', '<key>RunAtLoad</key><false/>', 'packages/service/src/service.test.ts', 'LaunchAgent starts'),
    ('restart throttle removed', 'packages/service/src/plan.ts', '<integer>15</integer>', '<integer>0</integer>', 'packages/service/src/service.test.ts', 'LaunchAgent starts'),
    ('crash restart disabled', 'packages/service/src/plan.ts', 'Restart=always', 'Restart=no', 'packages/service/src/service.test.ts', 'user systemd unit'),
    ('signature verification bypassed', 'packages/service/src/artifact.ts', '!verify(null, bytes, key, Buffer.from(signature, "base64"))', 'false', 'packages/service/src/update.test.ts', 'a bad signature'),
    ('checksum verification bypassed', 'packages/service/src/artifact.ts', 'bytes !== manifest.bytes || hash.digest("hex") !== manifest.sha256', 'bytes !== manifest.bytes', 'packages/service/src/update.test.ts', 'a bad checksum'),
    ('active-tree barrier bypassed', 'packages/service/src/update.ts', 'while (status.blockers > 0)', 'while (status.blockers < 0)', 'packages/service/src/update.test.ts', 'active trees block'),
    ('rollback points at candidate', 'packages/service/src/update.ts', 'await atomicPointer(join(root, "current"), journal.old);', 'await atomicPointer(join(root, "current"), journal.candidate);', 'packages/service/src/update.test.ts', 'failed candidate health'),
    ('migration dry-run omitted', 'packages/service/src/update.ts', 'await ports.migrate(staging, check);', 'await Promise.resolve();', 'packages/service/src/update.test.ts', 'a failed migration'),
    ('command admission left open', 'packages/service/src/maintenance.ts', 'return !this.draining;', 'return true;', 'apps/daemon/src/maintenance.server.test.ts', 'maintenance closes websocket'),
]
results = []
for name, file, original, replacement, test, pattern in mutations:
    path = Path(file)
    source = path.read_text()
    if source.count(original) != 1:
        raise RuntimeError(f'Mutation anchor ambiguous: {name}')
    log = Path('tools/release/verification/' + name.replace(' ', '-') + '.log')
    if '--resume' in sys.argv and log.exists() and '1 failed' in log.read_text() and ('AssertionError' in log.read_text() or 'ENOENT' in log.read_text()):
        results.append({'mutation': name, 'test': pattern, 'killed': True})
        continue
    try:
        path.write_text(source.replace(original, replacement))
        outcome = subprocess.run(['bun', 'run', 'test', test, '-t', pattern, '--maxWorkers=1', '--testTimeout=60000'], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        Path('tools/release/verification/' + name.replace(' ', '-') + '.log').write_text(outcome.stdout)
        killed = outcome.returncode == 1 and ('AssertionError' in outcome.stdout or 'ENOENT' in outcome.stdout)
        results.append({'mutation': name, 'test': pattern, 'killed': killed})
        print(json.dumps(results[-1]), flush=True)
        if not killed:
            raise RuntimeError(f'Mutation survived or failed without an assertion: {name}')
    finally:
        path.write_text(source)
Path('tools/release/verification/results.json').write_text(json.dumps(results, indent=2) + '\n')
