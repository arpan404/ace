"""Apply behavior-bearing mutations sequentially, require failure, always restore."""
from pathlib import Path
import json
import subprocess

root=Path(__file__).resolve().parent.parent
mutations=[
    ('policy.rs','None if present(wayland)', 'None if false && present(wayland)', 'Wayland wins over XWayland'),
    ('policy.rs','self.dirty = false;', 'self.dirty = true;', 'idle capture has no timer or repeated frames'),
    ('policy.rs','!self.dirty || now < self.deadline', '!self.dirty', 'damage is capped at requested fps'),
    ('policy.rs','x >= f64::from(width)', 'x > f64::from(width)', 'right edge is outside target'),
    ('policy.rs','pointer: devices & 2 != 0', 'pointer: devices & 1 != 0', 'portal pointer grants follow device bits'),
    ('policy.rs','persistent: version >= 2', 'persistent: version >= 3', 'RemoteDesktop v2 persistence is supported'),
    ('protocol.rs','!(1..=30).contains(&n)', '!(1..=31).contains(&n)', 'invalid fps cannot start capture'),
    ('traversal.rs','depth > 32', 'depth > 33', 'tree depth cannot exceed hard cap'),
]
results=[]
subprocess.run(['cargo','test','--test','policy'],cwd=root,check=True)
for file,before,after,behavior in mutations:
    path=root/'src'/file
    original=path.read_text()
    assert original.count(before)==1,(file,before)
    try:
        path.write_text(original.replace(before,after))
        result=subprocess.run(['cargo','test','--test','policy'],cwd=root,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
        assert result.returncode!=0,behavior+' survived'
        assert 'test result: FAILED' in result.stdout,behavior+' did not produce a behavioral failure'
        results.append(dict(behavior=behavior,file=file,mutation=before+' -> '+after,killed=True))
        print('KILLED: '+behavior,flush=True)
    finally:
        path.write_text(original)
(root/'bench'/'mutation-results.json').write_text(json.dumps(results,indent=2)+'\n')
subprocess.run(['cargo','test','--test','policy'],cwd=root,check=True)
