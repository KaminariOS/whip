#ifndef REACT_NATIVE_RUSSH_H
#define REACT_NATIVE_RUSSH_H

#include <stdint.h>
#include <stddef.h>

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
typedef void (*react_native_russh_native_channel_open_callback)(uint64_t context,
                                                                 const char *error);
typedef void (*react_native_russh_native_channel_frame_callback)(uint64_t context,
                                                                  const uint8_t *bytes,
                                                                  size_t length);
typedef void (*react_native_russh_native_channel_closed_callback)(uint64_t context,
                                                                   const char *reason);
typedef void (*react_native_russh_native_unix_socket_request_callback)(
    uint64_t context,
    const uint8_t *bytes,
    size_t length,
    const char *error);
void react_native_russh_request_native_unix_socket(
    uint64_t context,
    const char *key,
    const char *socket_path,
    const uint8_t *request,
    size_t request_length,
    uint8_t response_terminator,
    uint64_t timeout_ms,
    size_t max_response_bytes,
    react_native_russh_native_unix_socket_request_callback callback);
void react_native_russh_open_native_unix_socket_channel(
    uint64_t context,
    const char *key,
    const char *channel_id,
    const char *socket_path,
    size_t max_frame_bytes,
    react_native_russh_native_channel_open_callback opened,
    react_native_russh_native_channel_frame_callback frame,
    react_native_russh_native_channel_closed_callback closed);
void react_native_russh_open_native_length_prefixed_unix_socket_channel(
    uint64_t context,
    const char *key,
    const char *channel_id,
    const char *socket_path,
    size_t max_frame_bytes,
    react_native_russh_native_channel_open_callback opened,
    react_native_russh_native_channel_frame_callback frame,
    react_native_russh_native_channel_closed_callback closed);
char *react_native_russh_write_native_length_prefixed_unix_socket_channel(
    const char *key,
    const char *channel_id,
    const uint8_t *bytes,
    size_t length);
char *react_native_russh_write_native_unix_socket_channel(
    const char *key,
    const char *channel_id,
    const uint8_t *bytes,
    size_t length);
char *react_native_russh_close_native_unix_socket_channel(const char *key,
                                                           const char *channel_id);
void react_native_russh_shutdown(void);

#ifdef __cplusplus
}
#endif

#endif
