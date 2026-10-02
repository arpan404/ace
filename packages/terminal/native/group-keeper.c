#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

/* A resident member of the PTY session can join another group with setpgid.
 * The kernel rejects groups in a foreign session atomically. A guardian then
 * pins the group ID across STOP, inventory failures and subsequent signals. */
#define MAX_PINS 4096
struct pin { pid_t group; pid_t child; };
static struct pin pins[MAX_PINS];
static size_t count;
static pid_t original;
static int input_fd = -1;

static int pin_group(pid_t group) {
  if (group == original) return 1;
  for (size_t i = 0; i < count; ++i) {
    if (pins[i].group != group) continue;
    int status;
    pid_t result = waitpid(pins[i].child, &status, WNOHANG);
    if (result == 0) return 1; /* A live or stopped member still reserves PGID. */
    pins[i] = pins[--count];
    break;
  }
  if (count == MAX_PINS) { errno = ENOSPC; return -1; }
  int link[2];
  if (pipe(link) < 0) return -1;
  pid_t child = fork();
  if (child == 0) {
    close(link[0]);
    /* Only the resident keeper may prove the private lifetime lease. */
    if (input_fd >= 0) close(input_fd);
    /* Never create a new group with a recycled numeric ID. Only join one. */
    int error = 0;
    if (group == getpid() || setpgid(0, group) < 0) error = EPERM;
    if (write(link[1], &error, sizeof(error)) != sizeof(error)) _exit(1);
    close(link[1]);
    if (error) _exit(0);
    for (;;) pause();
  }
  close(link[1]);
  if (child < 0) { close(link[0]); return -1; }
  int error = EIO;
  ssize_t bytes;
  do { bytes = read(link[0], &error, sizeof(error)); } while (bytes < 0 && errno == EINTR);
  close(link[0]);
  if (bytes != sizeof(error) || error) {
    kill(child, SIGKILL);
    while (waitpid(child, NULL, 0) < 0 && errno == EINTR) {}
    if (bytes == sizeof(error) && error == EPERM) return 0;
    errno = EIO;
    return -1;
  }
  pins[count++] = (struct pin){ group, child };
  return 1;
}

static int signal_owned(pid_t group, int sig) {
  int pinned = pin_group(group);
  if (pinned <= 0) return pinned;
  if (kill(-group, sig) < 0 && errno != ESRCH) return -1;
  if (sig == SIGKILL) {
    for (size_t i = 0; i < count; ++i) {
      if (pins[i].group != group) continue;
      /* This child only pauses; it cannot be stuck in a job's filesystem I/O.
       * Reap before forgetting it, then never trust the old numeric group again. */
      while (waitpid(pins[i].child, NULL, 0) < 0 && errno == EINTR) {}
      pins[i] = pins[--count];
      break;
    }
  }
  return 1;
}

/* EOF is daemon death, not just keeper death. Discover remaining same-session
 * groups as well as pinned stopped jobs, then kill the original group last. */
static void reap_session(void) {
  FILE *table = popen("/bin/ps -e -o pid=,pgid=", "r");
  if (table) {
    long pid, group;
    while (fscanf(table, "%ld %ld", &pid, &group) == 2) {
      if (pid <= 0 || pid > INT_MAX || group <= 0 || group > INT_MAX) continue;
      if (group != original && getsid((pid_t)pid) == original)
        signal_owned((pid_t)group, SIGKILL);
    }
    pclose(table);
  }
  while (count) {
    pid_t group = pins[count - 1].group;
    signal_owned(group, SIGKILL);
    /* Remove it without trusting this ID again after its guardian is reaped. */
    for (size_t i = 0; i < count; ++i) {
      if (pins[i].group == group) { pins[i] = pins[--count]; break; }
    }
  }
  kill(-original, SIGKILL);
  _exit(0);
}

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  original = getpgrp();
  for (int sig = 1; sig < 64; ++sig)
    if (sig != SIGKILL && sig != SIGSTOP) signal(sig, SIG_IGN);
  signal(SIGCHLD, SIG_DFL);
  FILE *input = fopen(argv[1], "r");
  if (!input) return 2;
  input_fd = fileno(input);
  FILE *ready = fopen(argv[2], "w");
  if (!ready) return 2;
  fputs("ready", ready);
  fclose(ready);
  char line[128], response[PATH_MAX], pending[PATH_MAX];
  while (fgets(line, sizeof(line), input)) {
    unsigned long id;
    long group;
    int sig;
    char extra;
    if (sscanf(line, "%lu %ld %d %c", &id, &group, &sig, &extra) != 3) continue;
    if (!id || group <= 0 || group > INT_MAX || sig <= 0 || sig >= 64) continue;
    /* Original-group KILL is handled by the daemon after secondary groups end. */
    if (group == original && sig == SIGKILL) continue;
    int result = signal_owned((pid_t)group, sig);
    int error = result < 0 ? errno : 0;
    int a = snprintf(response, sizeof(response), "%s.%lu", argv[2], id);
    int b = snprintf(pending, sizeof(pending), "%s.%lu.tmp", argv[2], id);
    if (a < 0 || b < 0 || a >= sizeof(response) || b >= sizeof(pending)) continue;
    FILE *reply = fopen(pending, "w");
    if (!reply) continue;
    fprintf(reply, "{\"id\":%lu,\"result\":%d,\"error\":%d}", id, result, error);
    fclose(reply);
    rename(pending, response);
  }
  reap_session();
}
