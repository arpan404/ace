"""Non-gating Linux session metrics. Called by the integration harness, with real capture."""
from pathlib import Path
import os
import time
import select

def ticks(pid):
    fields=Path('/proc/'+str(pid)+'/stat').read_text().split(') ',1)[1].split()
    return int(fields[11])+int(fields[12])

def measure(pid,frames,read_frame,animate):
    # Duration is sampling configuration, never an assertion or a test deadline.
    while select.select([frames],[],[],0)[0]:
        read_frame(frames)
    start=time.perf_counter();before=ticks(pid)
    time.sleep(2)
    idle=(ticks(pid)-before)/os.sysconf('SC_CLK_TCK')/(time.perf_counter()-start)*100
    animate()
    before=ticks(pid);start=time.perf_counter();count=0
    while time.perf_counter()-start<2:
        if select.select([frames],[],[],0.1)[0]:
            read_frame(frames);count+=1
    changing=(ticks(pid)-before)/os.sysconf('SC_CLK_TCK')/(time.perf_counter()-start)*100
    rss=int(Path('/proc/'+str(pid)+'/status').read_text().split('VmRSS:')[1].split()[0])
    return dict(idle_cpu_percent=idle,changing_cpu_percent=changing,observed_frames=count,requested_fps=10,rss_kib=rss)
