// Shared argument/error handling for the Windows Node-API binding modules.
#ifndef ACE_WINDOWS_BINDING_H
#define ACE_WINDOWS_BINDING_H
#ifdef _WIN32
#include <node_api.h>
#include <stdint.h>
napi_value throw_binding_error(napi_env env, const char *op);
napi_value fail_for(napi_env env, const char *op, const char *code,
    const char *detail);
int read_string(napi_env env, napi_value value, char *buffer, size_t cap,
    size_t *out_len);
int read_fd(napi_env env, napi_value value, int32_t *out);
napi_status wcore_define_metadata(napi_env env, napi_value exports);
#endif
#endif
