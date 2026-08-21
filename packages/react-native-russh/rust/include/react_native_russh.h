#ifndef REACT_NATIVE_RUSSH_H
#define REACT_NATIVE_RUSSH_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

char *react_native_russh_call(const char *request_json);
typedef void (*react_native_russh_response_callback)(uint64_t request_id,
                                           const char *response_json);
void react_native_russh_call_async(uint64_t request_id, const char *request_json,
                         react_native_russh_response_callback callback);
void react_native_russh_string_free(char *value);
typedef void (*react_native_russh_event_callback)(const char *event_json);
void react_native_russh_set_event_callback(react_native_russh_event_callback callback);
void react_native_russh_shutdown(void);

#ifdef __cplusplus
}
#endif

#endif
