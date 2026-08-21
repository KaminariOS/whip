#ifndef WHIP_SSH_H
#define WHIP_SSH_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

char *whip_ssh_call(const char *request_json);
typedef void (*whip_ssh_response_callback)(uint64_t request_id,
                                           const char *response_json);
void whip_ssh_call_async(uint64_t request_id, const char *request_json,
                         whip_ssh_response_callback callback);
void whip_ssh_string_free(char *value);
typedef void (*whip_ssh_event_callback)(const char *event_json);
void whip_ssh_set_event_callback(whip_ssh_event_callback callback);
void whip_ssh_shutdown(void);

#ifdef __cplusplus
}
#endif

#endif
