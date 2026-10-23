// NAPI surface for the Windows handle core.
//
// openRoot(volumePath) -> fd
// openDirectoryAt(parentFd, name) -> fd
// openFileAt(parentFd, name) -> fd
// openMetadataAt(parentFd, name) -> metadata fd for the child itself
// openPrivateMetadataAt(parentFd, name) -> private metadata fd (metadata-only
// access with WRITE_DAC, regular single link + current-user owner required)
// createFileAt(parentFd, name) -> writable fd, exclusive create
// mkdirAt(parentFd, name) -> void, exclusive directory creation
// identityOf(fd) -> { vol: string, id: string }
// statAt(parentFd, name) -> { vol, id, mode, size, mtimeMs, attrs }
// names(dirFd, cap) -> string[] (at most cap, no "." / "..")
//
// NAPI carries only ints (Node-owned fds) and strings. HANDLEs never
// cross NAPI. There is deliberately no native close/read/write: fd lifetime
// stays with the Node side (Node close routes through libuv and
// releases the HANDLE), and Node fs operates on the bridged fds directly.
// The only native close is error-only cleanup below (never exposed): when a
// fresh fd was created but its NAPI int wrapper fails, the fd is closed with
// Node's uv_fs_close so neither the CRT slot nor the HANDLE leaks.
// CloseHandle alone is never used for this (it would orphan the CRT slot).
// Borrowed parent/identity HANDLEs are never closed or stored.
//
// Errors are JS Errors with a POSIX `code` string ("ENOENT", "ELOOP",
// "EINVAL", "ENOTDIR", "EISDIR", "EACCES", "ENOTSUP", "EBADF", "EMFILE",
// "EIO", ...). UNC refusal surfaces as ENOTSUP with a UNC-specific message.

#ifdef _WIN32
#include "windows_binding.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "windows_core.h"

// True when a JS exception is already pending; callers preserve it by
// returning NULL without throwing anything new.
static int napi_has_pending(napi_env env) {
  bool pending = false;
  if (napi_is_exception_pending(env, &pending) != napi_ok) return 0;
  return pending ? 1 : 0;
}

// Brief binding fallback for NAPI-layer failures (create/set/define). Checks
// for a pending exception first and preserves it. Calls napi_throw_error
// directly and never fail_with/fail_for, so error-handler recursion is
// impossible.
napi_value throw_binding_error(napi_env env, const char *op) {
  if (napi_has_pending(env)) return NULL;
  char message[128];
  (void)snprintf(message, sizeof(message), "%s: NAPI binding failure",
      op != NULL ? op : "addon");
  (void)napi_throw_error(env, "EIO", message);
  return NULL;
}

// Error-only fd cleanup for the narrow window where wcore_open_* succeeded
// but wrapping the fresh fd as a JS int failed. Uses the same Node libuv
// runtime as uv_open_osfhandle, never
// CloseHandle alone. Not exposed to JS.
static void close_fd_quiet(int fd) {
  if (fd >= 0) (void)wcore_close_fd(fd);
}

static napi_value fail_with(napi_env env, const char *code, const char *message) {
  if (napi_has_pending(env)) return NULL;
  napi_value text = NULL;
  napi_value error = NULL;
  napi_value value = NULL;
  if (napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &text) != napi_ok)
    return throw_binding_error(env, "addon");
  if (napi_create_error(env, NULL, text, &error) != napi_ok)
    return throw_binding_error(env, "addon");
  if (napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &value) != napi_ok)
    return throw_binding_error(env, "addon");
  if (napi_set_named_property(env, error, "code", value) != napi_ok)
    return throw_binding_error(env, "addon");
  if (napi_throw(env, error) != napi_ok) return throw_binding_error(env, "addon");
  return NULL;
}

// Detail messages keep the refusal explicit. The single-component name is
// caller input and safe to echo; the volume path is echoed for the same
// reason (it is never joined with anything).
napi_value fail_for(napi_env env, const char *op, const char *code,
    const char *detail) {
  if (napi_has_pending(env)) return NULL;
  char message[1152];
  if (strcmp(code, "ENOTSUP") == 0) {
    (void)snprintf(message, sizeof(message),
        "%s: UNC roots are not supported by this first cut (refusing without fallback): %.512s",
        op, detail != NULL ? detail : "");
  } else if (detail != NULL) {
    (void)snprintf(message, sizeof(message), "%s failed with %s: %.512s", op, code, detail);
  } else {
    (void)snprintf(message, sizeof(message), "%s failed with %s", op, code);
  }
  return fail_with(env, code, message);
}

int read_string(napi_env env, napi_value value, char *buffer, size_t cap,
    size_t *out_len) {
  size_t len = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &len) != napi_ok) return 0;
  if (len == 0 || len >= cap) return 0;
  if (napi_get_value_string_utf8(env, value, buffer, cap, &len) != napi_ok)
    return 0;
  // Embedded NUL would truncate downstream; the validator re-checks anyway.
  if (strlen(buffer) != len) return 0;
  if (out_len != NULL) *out_len = len;
  return 1;
}

// Strict fd check shared by child-parent and identity fds. napi_get_value_int32
// truncates fractions, wraps 2^32, and maps NaN/Inf to 0, so every invalid
// value must fail closed here with EINVAL before any borrow. Accept only a
// finite integral double in 0..INT32_MAX with cast equality.
int read_fd(napi_env env, napi_value value, int32_t *out) {
  double number = 0;
  if (napi_get_value_double(env, value, &number) != napi_ok) return 0;
  if (!(number >= 0.0 && number <= 2147483647.0)) return 0;
  int32_t checked = (int32_t)number;
  if ((double)checked != number) return 0;
  if (out != NULL) *out = checked;
  return 1;
}

static napi_value do_open_root(napi_env env, napi_callback_info info) {
  napi_value args[1];
  napi_value result = NULL;
  size_t count = 1;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok ||
      count != 1)
    return fail_for(env, "openRoot", "EINVAL", NULL);
  size_t len = 0;
  if (napi_get_value_string_utf8(env, args[0], NULL, 0, &len) != napi_ok ||
      len == 0 || len > 32767)
    return fail_for(env, "openRoot", "EINVAL", NULL);
  char *path = (char *)malloc(len + 1);
  if (path == NULL) return fail_for(env, "openRoot", "EMFILE", NULL);
  size_t actual = 0;
  if (napi_get_value_string_utf8(env, args[0], path, len + 1, &actual) != napi_ok ||
      actual != len || strlen(path) != len) {
    free(path);
    return fail_for(env, "openRoot", "EINVAL", NULL);
  }
  int fd = -1;
  const char *code = wcore_open_root(path, &fd);
  if (code != NULL) {
    fail_for(env, "openRoot", code, path);
    free(path);
    return NULL;
  }
  free(path);
  // Success transfers fd ownership to JS. If the wrapper fails, close the
  // just-created fd so cleanup cannot leak a CRT slot/HANDLE.
  if (napi_create_int32(env, fd, &result) != napi_ok) {
    close_fd_quiet(fd);
    return throw_binding_error(env, "openRoot");
  }
  return result;
}

typedef const char *(*fd_opener)(int, const char *, int *);

static napi_value open_child_at(napi_env env, napi_callback_info info,
    const char *op, fd_opener open) {
  napi_value args[2];
  napi_value result = NULL;
  size_t count = 2;
  int32_t parent = -1;
  char name[1025];
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok ||
      count != 2 || !read_fd(env, args[0], &parent) ||
      !read_string(env, args[1], name, sizeof(name), NULL))
    return fail_for(env, op, "EINVAL", NULL);
  int fd = -1;
  const char *code = open(parent, name, &fd);
  if (code != NULL) return fail_for(env, op, code, name);
  if (napi_create_int32(env, fd, &result) != napi_ok) {
    close_fd_quiet(fd);
    return throw_binding_error(env, op);
  }
  return result;
}

static napi_value do_open_directory_at(napi_env env, napi_callback_info info) {
  return open_child_at(env, info, "openDirectoryAt", wcore_open_dir_at);
}

static napi_value do_open_file_at(napi_env env, napi_callback_info info) {
  return open_child_at(env, info, "openFileAt", wcore_open_file_at);
}

static napi_value do_open_metadata_at(napi_env env, napi_callback_info info) {
  return open_child_at(env, info, "openMetadataAt", wcore_open_metadata_at);
}

static napi_value do_open_private_metadata_at(napi_env env, napi_callback_info info) {
  return open_child_at(env, info, "openPrivateMetadataAt",
      wcore_open_private_metadata_at);
}

static napi_value do_create_file_at(napi_env env, napi_callback_info info) {
  return open_child_at(env, info, "createFileAt", wcore_create_file_at);
}

static napi_value do_create_private_file_at(napi_env env, napi_callback_info info) {
  return open_child_at(env, info, "createPrivateFileAt", wcore_create_private_file_at);
}

typedef const char *(*child_mutation)(int, const char *);

static napi_value mutate_child_at(napi_env env, napi_callback_info info,
    const char *op, child_mutation mutate) {
  napi_value args[2], result = NULL;
  size_t count = 2;
  int32_t parent = -1;
  char name[1025];
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok ||
      count != 2 || !read_fd(env, args[0], &parent) ||
      !read_string(env, args[1], name, sizeof(name), NULL))
    return fail_for(env, op, "EINVAL", NULL);
  const char *code = mutate(parent, name);
  if (code != NULL) return fail_for(env, op, code, name);
  if (napi_get_undefined(env, &result) != napi_ok)
    return throw_binding_error(env, op);
  return result;
}

static napi_value do_mkdir_at(napi_env env, napi_callback_info info) {
  return mutate_child_at(env, info, "mkdirAt", wcore_mkdir_at);
}

static napi_value do_secure_private_at(napi_env env, napi_callback_info info) {
  return mutate_child_at(env, info, "securePrivateAt", wcore_secure_private_at);
}

static napi_value do_secure_private_fd(napi_env env, napi_callback_info info) {
  napi_value args[1];
  napi_value result = NULL;
  size_t count = 1;
  int32_t fd = -1;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok ||
      count != 1 || !read_fd(env, args[0], &fd))
    return fail_for(env, "securePrivateFd", "EINVAL", NULL);
  const char *code = wcore_secure_private_fd(fd);
  if (code != NULL) return fail_for(env, "securePrivateFd", code, NULL);
  if (napi_get_undefined(env, &result) != napi_ok)
    return throw_binding_error(env, "securePrivateFd");
  return result;
}

static napi_value do_check_private_at(napi_env env, napi_callback_info info) {
  return mutate_child_at(env, info, "checkPrivateAt", wcore_check_private_at);
}

static napi_value do_check_private_fd(napi_env env, napi_callback_info info) {
  napi_value args[1];
  napi_value result = NULL;
  size_t count = 1;
  int32_t fd = -1;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok ||
      count != 1 || !read_fd(env, args[0], &fd))
    return fail_for(env, "checkPrivateFd", "EINVAL", NULL);
  const char *code = wcore_check_private_fd(fd);
  if (code != NULL) return fail_for(env, "checkPrivateFd", code, NULL);
  if (napi_get_undefined(env, &result) != napi_ok)
    return throw_binding_error(env, "checkPrivateFd");
  return result;
}

static napi_value do_unlink_at(napi_env env, napi_callback_info info) {
  return mutate_child_at(env, info, "unlinkAt", wcore_unlink_at);
}

static napi_value do_remove_directory_at(napi_env env, napi_callback_info info) {
  return mutate_child_at(env, info, "removeDirectoryAt", wcore_remove_directory_at);
}

typedef const char *(*child_rename)(int, const char *, const char *);

static napi_value rename_child_at(napi_env env, napi_callback_info info,
    const char *op, child_rename rename) {
  napi_value args[3], result = NULL;
  size_t count = 3;
  int32_t parent = -1;
  char from[1025], to[1025];
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok ||
      count != 3 || !read_fd(env, args[0], &parent) ||
      !read_string(env, args[1], from, sizeof(from), NULL) ||
      !read_string(env, args[2], to, sizeof(to), NULL))
    return fail_for(env, op, "EINVAL", NULL);
  const char *code = rename(parent, from, to);
  if (code != NULL) return fail_for(env, op, code, from);
  if (napi_get_undefined(env, &result) != napi_ok)
    return throw_binding_error(env, op);
  return result;
}

static napi_value do_rename_at(napi_env env, napi_callback_info info) {
  return rename_child_at(env, info, "renameAt", wcore_rename_at);
}

static napi_value do_rename_exclusive_at(napi_env env, napi_callback_info info) {
  return rename_child_at(env, info, "renameExclusiveAt", wcore_rename_exclusive_at);
}

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"openRoot", NULL, do_open_root, NULL, NULL, NULL, napi_default, NULL},
    {"openDirectoryAt", NULL, do_open_directory_at, NULL, NULL, NULL, napi_default, NULL},
    {"openFileAt", NULL, do_open_file_at, NULL, NULL, NULL, napi_default, NULL},
    {"openMetadataAt", NULL, do_open_metadata_at, NULL, NULL, NULL, napi_default, NULL},
    {"openPrivateMetadataAt", NULL, do_open_private_metadata_at, NULL, NULL, NULL, napi_default, NULL},
    {"createFileAt", NULL, do_create_file_at, NULL, NULL, NULL, napi_default, NULL},
    {"createPrivateFileAt", NULL, do_create_private_file_at, NULL, NULL, NULL, napi_default, NULL},
    {"unlinkAt", NULL, do_unlink_at, NULL, NULL, NULL, napi_default, NULL},
    {"removeDirectoryAt", NULL, do_remove_directory_at, NULL, NULL, NULL, napi_default, NULL},
    {"renameAt", NULL, do_rename_at, NULL, NULL, NULL, napi_default, NULL},
    {"renameExclusiveAt", NULL, do_rename_exclusive_at, NULL, NULL, NULL, napi_default, NULL},
    {"securePrivateAt", NULL, do_secure_private_at, NULL, NULL, NULL, napi_default, NULL},
    {"securePrivateFd", NULL, do_secure_private_fd, NULL, NULL, NULL, napi_default, NULL},
    {"checkPrivateAt", NULL, do_check_private_at, NULL, NULL, NULL, napi_default, NULL},
    {"checkPrivateFd", NULL, do_check_private_fd, NULL, NULL, NULL, napi_default, NULL},
    {"mkdirAt", NULL, do_mkdir_at, NULL, NULL, NULL, napi_default, NULL},
  };
  if (napi_define_properties(env, exports,
          sizeof(methods) / sizeof(methods[0]), methods) != napi_ok)
    return throw_binding_error(env, "init");
  if (wcore_define_metadata(env, exports) != napi_ok)
    return throw_binding_error(env, "init");
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
#endif
