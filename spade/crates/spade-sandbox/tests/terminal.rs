//! A dedicated terminal per command (ADR 0167 amendment 1, decision 4): the person's terminal is
//! a real same-user pty here, handed to the launcher as stdio the way a shell would.
#![cfg(all(target_os = "linux", feature = "landlock"))]
mod linux;

use std::process::Output;

/// Runs `parent` (Python) with `ARGS`, the launcher's command line for `python3 -c <inside>`.
fn drive(inside: &str, parent: &str) -> Output {
    let w = linux::world();
    let launch = linux::runner()
        .wrap(
            &linux::policy(&w, None),
            std::path::Path::new("/usr/bin/python3"),
            &["-c".into(), inside.into()],
        )
        .unwrap_or_else(|e| panic!("{e}"));
    let args: Vec<String> = std::iter::once(launch.program.to_string_lossy().into_owned())
        .chain(launch.args.iter().map(|a| a.to_string_lossy().into_owned()))
        .collect();
    let json = serde_json::to_string(&serde_json::to_string(&args).unwrap_or_default())
        .unwrap_or_default();
    let prelude = format!(
        r#"import errno,fcntl,json,os,pty,select,struct,subprocess,termios,time
ARGS=json.loads({json})
def size(fd): return struct.unpack("HHHH",fcntl.ioctl(fd,termios.TIOCGWINSZ,b"\0"*8))[:2]
def terminal():
 m,s=pty.openpty(); fcntl.ioctl(s,termios.TIOCSWINSZ,struct.pack("HHHH",24,80,0,0)); return m,s
def collect(m,p,answer=None):
 out=b""; deadline=time.time()+20
 while time.time()<deadline:
  r,_,_=select.select([m],[],[],0.1)
  if r:
   try: out+=os.read(m,4096)
   except OSError: break
   if answer and answer[0] in out: os.write(m,answer[1]); answer=None
  elif p.poll() is not None: break
 p.wait(timeout=5); return out.decode(errors="replace")
"#
    );
    let out = std::process::Command::new("python3")
        .args(["-c", &format!("{prelude}{parent}")])
        .current_dir(&w.workspace)
        .output()
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(
        out.status.success(),
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    out
}

#[test]
fn terminal_changes_land_on_the_commands_own_pty_and_never_on_the_persons() {
    let inside = r#"import fcntl,os,struct,sys,termios
person=os.stat(sys.argv[1]).st_rdev if len(sys.argv)>1 else None
fcntl.ioctl(0,termios.TIOCSWINSZ,struct.pack("HHHH",50,100,0,0))
size=struct.unpack("HHHH",fcntl.ioctl(0,termios.TIOCGWINSZ,b"\0"*8))[:2]
t=termios.tcgetattr(0); t[3]&=~termios.ECHO; termios.tcsetattr(0,termios.TCSANOW,t)
echo=bool(termios.tcgetattr(0)[3]&termios.ECHO)
held=[os.fstat(i).st_rdev for i in range(3)]
print("dedicated",os.ttyname(0),size,echo,os.tcgetpgrp(0)==os.getpgrp(),person in held,flush=True)
"#;
    let parent = r#"
m,s=terminal(); before=termios.tcgetattr(s)
p=subprocess.Popen(ARGS+[os.ttyname(s)],stdin=s,stdout=s,stderr=s)
text=collect(m,p)
assert p.returncode==0,(p.returncode,text)
assert "dedicated /dev/pts/" in text and os.ttyname(s)+" " not in text,text
assert "(50, 100) False True False" in text,text
# The person's terminal: its size and modes as they were, raw mode undone.
assert size(s)==(24,80),size(s)
assert termios.tcgetattr(s)==before
"#;
    drive(inside, parent);
}

#[test]
fn a_terminal_that_isnt_the_dedicated_pty_can_be_read_but_not_changed() {
    // The person's terminal leaks to the command as descriptor 9, beside its own stdio.
    let inside = r#"import errno,fcntl,struct,termios
fcntl.ioctl(9,termios.TIOCGWINSZ,b"\0"*8); termios.tcgetattr(9)
for change in (lambda: fcntl.ioctl(9,termios.TIOCSWINSZ,struct.pack("HHHH",9,9,0,0)),
               lambda: termios.tcsetattr(9,termios.TCSANOW,termios.tcgetattr(9))):
 try: change()
 except (OSError,termios.error) as e: assert e.args[0]==errno.EPERM,e
 else: raise SystemExit("changed a terminal that isn't the dedicated pty")
print("refused",flush=True)
"#;
    let parent = r#"
m,s=terminal(); before=termios.tcgetattr(s)
os.dup2(s,9)
p=subprocess.Popen(ARGS,stdin=s,stdout=s,stderr=s,pass_fds=(9,))
text=collect(m,p)
assert p.returncode==0 and "refused" in text,(p.returncode,text)
assert size(s)==(24,80) and termios.tcgetattr(s)==before
"#;
    drive(inside, parent);
}

#[test]
fn keystrokes_reach_the_command_through_its_own_controlling_terminal() {
    let inside = r#"import os
line=input("ready> ")
os.close(os.open("/dev/tty",os.O_RDWR))
# Only a controlling terminal answers its foreground group.
print("got",line[::-1],os.tcgetpgrp(0)==os.getpgrp(),flush=True)
"#;
    let parent = r#"
m,s=terminal()
p=subprocess.Popen(ARGS,stdin=s,stdout=s,stderr=s)
text=collect(m,p,(b"ready> ",b"olleh\r"))
assert p.returncode==0 and "got hello True" in text,(p.returncode,text)
"#;
    drive(inside, parent);
}

#[test]
fn without_a_terminal_on_stdio_the_command_keeps_its_pipes() {
    let inside = r#"import os,sys
print([os.isatty(i) for i in range(3)],flush=True)
sys.stderr.write("to the pipe\n")
"#;
    let parent = r#"
r=subprocess.run(ARGS,stdin=subprocess.DEVNULL,capture_output=True,text=True)
assert r.returncode==0 and r.stdout.strip()=="[False, False, False]",r
assert r.stderr=="to the pipe\n",r
"#;
    drive(inside, parent);
}
