// Clean-room syscall bridge. Policy and traversal live in TypeScript.
#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <dirent.h>
#include <string.h>
#include <unistd.h>
#include <sys/stat.h>

static napi_value fail(napi_env env, int number) {
  napi_value message, error, value;
  napi_create_string_utf8(env, strerror(number), NAPI_AUTO_LENGTH, &message);
  napi_create_error(env, NULL, message, &error);
  napi_create_int32(env, -number, &value);
  napi_set_named_property(env, error, "errno", value);
  napi_throw(env, error);
  return NULL;
}
static napi_value open_root(napi_env env, napi_callback_info info) {
  napi_value args[1], result;
  size_t count = 1, size;
  char path[4096];
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 1 ||
      napi_get_value_string_utf8(env, args[0], NULL, 0, &size) != napi_ok ||
      size == 0 || size >= sizeof(path)) return fail(env, EINVAL);
  napi_get_value_string_utf8(env, args[0], path, sizeof(path), &size);
  if (strlen(path) != size || path[0] != '/') return fail(env, EINVAL);
  int descriptor = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0) return fail(env, errno);
  char *context;
  for (char *part = strtok_r(path, "/", &context); part; part = strtok_r(NULL, "/", &context)) {
    if (!strcmp(part, ".") || !strcmp(part, "..")) { close(descriptor); return fail(env, EINVAL); }
    int next = openat(descriptor, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next < 0) { int number = errno; close(descriptor); return fail(env, number); }
    close(descriptor);
    descriptor = next;
  }
  napi_create_int32(env, descriptor, &result);
  return result;
}
static napi_value open_at(napi_env env, napi_callback_info info) {
  napi_value args[3], result;
  size_t count = 3, size;
  int32_t parent, flags;
  char name[4096];
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 3 ||
      napi_get_value_int32(env, args[0], &parent) != napi_ok ||
      napi_get_value_int32(env, args[2], &flags) != napi_ok ||
      napi_get_value_string_utf8(env, args[1], NULL, 0, &size) != napi_ok ||
      size == 0 || size >= sizeof(name)) return fail(env, EINVAL);
  napi_get_value_string_utf8(env, args[1], name, sizeof(name), &size);
  // One component only: no hidden traversal or injected NUL allowed at this boundary.
  if (strlen(name) != size || strchr(name, '/') || !strcmp(name, ".") || !strcmp(name, ".."))
    return fail(env, EINVAL);
  int descriptor = openat(parent, name, flags | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
  if (descriptor < 0) return fail(env, errno);
  napi_create_int32(env, descriptor, &result);
  return result;
}
static napi_value stat_at(napi_env env, napi_callback_info info) {
  napi_value args[2], result, value;
  size_t count = 2, size;
  int32_t parent;
  char name[4096];
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 2 ||
      napi_get_value_int32(env, args[0], &parent) != napi_ok ||
      napi_get_value_string_utf8(env, args[1], NULL, 0, &size) != napi_ok ||
      size == 0 || size >= sizeof(name)) return fail(env, EINVAL);
  napi_get_value_string_utf8(env, args[1], name, sizeof(name), &size);
  if (strlen(name) != size || strchr(name, '/') || !strcmp(name, ".") || !strcmp(name, ".."))
    return fail(env, EINVAL);
  struct stat metadata;
  if (fstatat(parent, name, &metadata, AT_SYMLINK_NOFOLLOW) < 0) return fail(env, errno);
  napi_create_object(env, &result);
  napi_create_double(env, (double)metadata.st_dev, &value);
  napi_set_named_property(env, result, "dev", value);
  napi_create_double(env, (double)metadata.st_ino, &value);
  napi_set_named_property(env, result, "ino", value);
  napi_create_double(env, (double)metadata.st_mode, &value);
  napi_set_named_property(env, result, "mode", value);
  napi_create_double(env, (double)metadata.st_size, &value);
  napi_set_named_property(env, result, "size", value);
#ifdef __APPLE__
  double mtime = metadata.st_mtimespec.tv_sec * 1000.0 + metadata.st_mtimespec.tv_nsec / 1000000.0;
#else
  double mtime = metadata.st_mtim.tv_sec * 1000.0 + metadata.st_mtim.tv_nsec / 1000000.0;
#endif
  napi_create_double(env, mtime, &value);
  napi_set_named_property(env, result, "mtime", value);
  return result;
}
static napi_value names(napi_env env, napi_callback_info info) {
  napi_value args[2], result, value;
  size_t count = 2;
  int32_t descriptor, cap;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 2 ||
      napi_get_value_int32(env, args[0], &descriptor) != napi_ok ||
      napi_get_value_int32(env, args[1], &cap) != napi_ok || cap < 1 || cap > 10000)
    return fail(env, EINVAL);
  int duplicate = dup(descriptor);
  if (duplicate < 0) return fail(env, errno);
  DIR *directory = fdopendir(duplicate);
  if (!directory) { int number = errno; close(duplicate); return fail(env, number); }
  napi_create_array(env, &result);
  unsigned int index = 0;
  int problem = 0;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(directory);
    if (!entry) { problem = errno; break; }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (index >= (unsigned int)cap) { problem = E2BIG; break; }
    napi_create_string_utf8(env, entry->d_name, NAPI_AUTO_LENGTH, &value);
    napi_set_element(env, result, index++, value);
  }
  closedir(directory);
  if (problem) return fail(env, problem);
  return result;
}
static napi_value make_pipe(napi_env env, napi_callback_info info) {
  (void)info;
  int descriptors[2];
  if (pipe(descriptors) < 0) return fail(env, errno);
  if (fcntl(descriptors[0], F_SETFD, FD_CLOEXEC) < 0 || fcntl(descriptors[1], F_SETFD, FD_CLOEXEC) < 0) {
    int number = errno; close(descriptors[0]); close(descriptors[1]); return fail(env, number);
  }
  napi_value result, value;
  napi_create_object(env, &result);
  napi_create_int32(env, descriptors[0], &value);
  napi_set_named_property(env, result, "read", value);
  napi_create_int32(env, descriptors[1], &value);
  napi_set_named_property(env, result, "write", value);
  return result;
}
static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"openAt", NULL, open_at, NULL, NULL, NULL, napi_default, NULL},
    {"openRoot", NULL, open_root, NULL, NULL, NULL, napi_default, NULL},
    {"names", NULL, names, NULL, NULL, NULL, napi_default, NULL},
    {"statAt", NULL, stat_at, NULL, NULL, NULL, napi_default, NULL},
    {"pipe", NULL, make_pipe, NULL, NULL, NULL, napi_default, NULL}
  };
  napi_define_properties(env, exports, 5, methods);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
