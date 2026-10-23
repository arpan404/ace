// Metadata, identity and enumeration Node-API callbacks.
#ifdef _WIN32
#include "windows_binding.h"
#include "windows_core.h"

// Strict cap check for directory enumeration: finite integral double in
// 1..10000. Out-of-range is EINVAL; overflow beyond cap at runtime is E2BIG.
static int read_cap(napi_env env, napi_value value, int32_t *out) {
  double number = 0;
  if (napi_get_value_double(env, value, &number) != napi_ok) return 0;
  if (!(number >= 1.0 && number <= 10000.0)) return 0;
  int32_t checked = (int32_t)number;
  if ((double)checked != number) return 0;
  if (out != NULL) *out = checked;
  return 1;
}

static napi_value do_identity_of(napi_env env, napi_callback_info info) {
  napi_value args[1];
  napi_value result = NULL;
  napi_value value = NULL;
  size_t count = 1;
  int32_t fd = -1;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok ||
      count != 1 || !read_fd(env, args[0], &fd))
    return fail_for(env, "identityOf", "EINVAL", NULL);
  char vol[17], id[33];
  const char *code = wcore_identity_of(fd, vol, id);
  if (code != NULL) return fail_for(env, "identityOf", code, NULL);
  // Borrowed fd only: never close here; ownership stays with the JS side.
  if (napi_create_object(env, &result) != napi_ok)
    return throw_binding_error(env, "identityOf");
  if (napi_create_string_utf8(env, vol, NAPI_AUTO_LENGTH, &value) != napi_ok)
    return throw_binding_error(env, "identityOf");
  if (napi_set_named_property(env, result, "vol", value) != napi_ok)
    return throw_binding_error(env, "identityOf");
  value = NULL;
  if (napi_create_string_utf8(env, id, NAPI_AUTO_LENGTH, &value) != napi_ok)
    return throw_binding_error(env, "identityOf");
  if (napi_set_named_property(env, result, "id", value) != napi_ok)
    return throw_binding_error(env, "identityOf");
  return result;
}

static napi_value do_stat_at(napi_env env, napi_callback_info info) {
  napi_value args[2];
  napi_value result = NULL;
  napi_value value = NULL;
  size_t count = 2;
  int32_t parent = -1;
  char name[1025];
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok ||
      count != 2 || !read_fd(env, args[0], &parent) ||
      !read_string(env, args[1], name, sizeof(name), NULL))
    return fail_for(env, "statAt", "EINVAL", NULL);
  char vol[17], id[33];
  unsigned int mode = 0, attrs = 0;
  unsigned long long size = 0;
  double mtime_ms = 0;
  const char *code =
      wcore_stat_at(parent, name, vol, id, &mode, &size, &mtime_ms, &attrs);
  if (code != NULL) return fail_for(env, "statAt", code, name);
  if (napi_create_object(env, &result) != napi_ok)
    return throw_binding_error(env, "statAt");
  if (napi_create_string_utf8(env, vol, NAPI_AUTO_LENGTH, &value) != napi_ok)
    return throw_binding_error(env, "statAt");
  if (napi_set_named_property(env, result, "vol", value) != napi_ok)
    return throw_binding_error(env, "statAt");
  value = NULL;
  if (napi_create_string_utf8(env, id, NAPI_AUTO_LENGTH, &value) != napi_ok)
    return throw_binding_error(env, "statAt");
  if (napi_set_named_property(env, result, "id", value) != napi_ok)
    return throw_binding_error(env, "statAt");
  value = NULL;
  if (napi_create_int32(env, (int32_t)mode, &value) != napi_ok)
    return throw_binding_error(env, "statAt");
  if (napi_set_named_property(env, result, "mode", value) != napi_ok)
    return throw_binding_error(env, "statAt");
  value = NULL;
  if (napi_create_double(env, (double)size, &value) != napi_ok)
    return throw_binding_error(env, "statAt");
  if (napi_set_named_property(env, result, "size", value) != napi_ok)
    return throw_binding_error(env, "statAt");
  value = NULL;
  if (napi_create_double(env, mtime_ms, &value) != napi_ok)
    return throw_binding_error(env, "statAt");
  if (napi_set_named_property(env, result, "mtimeMs", value) != napi_ok)
    return throw_binding_error(env, "statAt");
  value = NULL;
  if (napi_create_uint32(env, attrs, &value) != napi_ok)
    return throw_binding_error(env, "statAt");
  if (napi_set_named_property(env, result, "attrs", value) != napi_ok)
    return throw_binding_error(env, "statAt");
  return result;
}

struct names_collect_ctx {
  napi_env env;
  napi_value array;
  uint32_t next;
  int failed;
};

static int names_sink(const char *utf8, size_t len, void *ctx) {
  struct names_collect_ctx *c = (struct names_collect_ctx *)ctx;
  if (c->failed) return 1;
  napi_value str = NULL;
  if (napi_create_string_utf8(c->env, utf8, len, &str) != napi_ok) {
    c->failed = 1;
    return 1;
  }
  if (napi_set_element(c->env, c->array, c->next, str) != napi_ok) {
    c->failed = 1;
    return 1;
  }
  c->next++;
  return 0;
}

static napi_value do_names(napi_env env, napi_callback_info info) {
  napi_value args[2];
  napi_value result = NULL;
  size_t count = 2;
  int32_t fd = -1, cap = 0;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok ||
      count != 2 || !read_fd(env, args[0], &fd) ||
      !read_cap(env, args[1], &cap))
    return fail_for(env, "names", "EINVAL", NULL);
  if (napi_create_array(env, &result) != napi_ok)
    return throw_binding_error(env, "names");
  struct names_collect_ctx ctx;
  ctx.env = env;
  ctx.array = result;
  ctx.next = 0;
  ctx.failed = 0;
  int out_count = 0;
  const char *code = wcore_names_collect(fd, cap, names_sink, &ctx, &out_count);
  if (ctx.failed) return throw_binding_error(env, "names");
  if (code != NULL) return fail_for(env, "names", code, NULL);
  (void)out_count;
  return result;
}

napi_status wcore_define_metadata(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"identityOf", NULL, do_identity_of, NULL, NULL, NULL, napi_default, NULL},
    {"statAt", NULL, do_stat_at, NULL, NULL, NULL, napi_default, NULL},
    {"names", NULL, do_names, NULL, NULL, NULL, napi_default, NULL},
  };
  return napi_define_properties(env, exports,
      sizeof(methods) / sizeof(methods[0]), methods);
}
#endif
