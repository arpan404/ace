#!/usr/bin/env python3
"""Summarise a Time Profiler trace: busy time per thread, then the main thread's heaviest
functions (inclusive and self) and its heaviest app-owned stacks, optionally within a time window.

Usage: profile-summary.py TRACE [--from S] [--to S] [--thread main|NAME] [--top N]
Run with `python3 -I`. Reads `xctrace export --xpath time-profile`.
"""
import argparse, collections, subprocess, xml.etree.ElementTree as ET

ap = argparse.ArgumentParser()
ap.add_argument("trace"); ap.add_argument("--from", dest="start", type=float, default=0)
ap.add_argument("--to", dest="end", type=float, default=1e9)
ap.add_argument("--thread", default="main"); ap.add_argument("--top", type=int, default=25)
ap.add_argument("--app", default="Ace", help="binary name counted as app-owned")
args = ap.parse_args()

if args.trace.endswith(".xml"):
    xml = open(args.trace, "rb").read()
else:
    xml = subprocess.run(["xcrun", "xctrace", "export", "--input", args.trace, "--xpath",
                          '/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]'],
                         capture_output=True, check=True).stdout
root = ET.fromstring(xml)
ids = {}
def resolve(el):
    if el is None: return None
    ref = el.get("ref")
    if ref is not None: return ids[ref]
    if el.get("id") is not None: ids[el.get("id")] = el
    for child in el: resolve(child)
    return el

per_thread = collections.Counter()
incl = collections.Counter(); self_ = collections.Counter(); app_stacks = collections.Counter()
samples = 0; weight_ms = 1.0
for row in root.iter("row"):
    resolve(row)
    t = resolve(row.find("sample-time")); th = resolve(row.find("thread")); bt = resolve(row.find("tagged-backtrace") if row.find("tagged-backtrace") is not None else row.find("backtrace"))
    w = resolve(row.find("weight"))
    if t is None or th is None: continue
    secs = int(t.text) / 1e9
    if not (args.start <= secs <= args.end): continue
    ms = int(w.text) / 1e6 if w is not None and w.text else 1.0
    name = th.get("fmt", "")
    per_thread[name] += ms
    is_main = "Main Thread" in name or name.startswith("Main")
    if not ((args.thread == "main" and is_main) or (args.thread != "main" and args.thread in name)): continue
    samples += 1
    frames = []
    if bt is not None:
        for f in bt.iter("frame"):
            f = resolve(f) if f.get("ref") else f
            binary = f.find("binary"); binary = resolve(binary) if binary is not None else None
            frames.append((f.get("name", "?"), binary.get("name", "") if binary is not None else ""))
    seen = set()
    for fname, _ in frames:
        if fname not in seen: incl[fname] += ms; seen.add(fname)
    if frames: self_[frames[0][0]] += ms
    owned = [fname for fname, b in frames if b == args.app][:6]
    if owned: app_stacks[" < ".join(owned)] += ms

print(f"window {args.start}-{args.end}s")
print("busy ms per thread (top 12):")
for name, ms in per_thread.most_common(12): print(f"  {ms:9.1f}  {name}")
print(f"\n{args.thread} thread samples: {samples}")
print("inclusive (top):")
for name, ms in incl.most_common(args.top): print(f"  {ms:9.1f}  {name[:150]}")
print("self (top):")
for name, ms in self_.most_common(15): print(f"  {ms:9.1f}  {name[:150]}")
print("app-owned stacks, innermost first (top):")
for name, ms in app_stacks.most_common(15): print(f"  {ms:9.1f}  {name[:300]}")
