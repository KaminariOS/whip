#import "RNSSHRustClient.h"
#import "whip_ssh.h"
#import <React/RCTLog.h>

typedef void (^RNSSHRustCompletion)(NSDictionary *response);

@interface RNSSHRustClient ()
@property(nonatomic, strong) dispatch_queue_t rustMethodQueue;
@property(nonatomic, strong) NSMutableDictionary<NSNumber *, RNSSHRustCompletion> *pendingCalls;
@property(nonatomic, assign) uint64_t nextRequestID;
- (void)completeRequest:(uint64_t)requestID response:(NSDictionary *)response;
@end

static __weak RNSSHRustClient *activeRustClient;

static void whipSSHEvent(const char *eventJSON) {
    RNSSHRustClient *client = activeRustClient;
    if (!eventJSON || !client) return;
    NSData *data = [[NSData alloc] initWithBytes:eventJSON length:strlen(eventJSON)];
    NSDictionary *event = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![event isKindOfClass:[NSDictionary class]]) return;
    void (^emit)(void) = ^{
        if (activeRustClient != client) return;
        NSString *name = event[@"name"] ?: @"Shell";
        [client sendEventWithName:name body:event];
    };
    // Apply backpressure instead of allowing terminal and transfer events to
    // grow the main dispatch queue without bound.
    if ([NSThread isMainThread]) emit();
    else dispatch_sync(dispatch_get_main_queue(), emit);
}

static void whipSSHResponse(uint64_t requestID, const char *responseJSON) {
    RNSSHRustClient *client = activeRustClient;
    if (!client || !responseJSON) return;
    NSData *data = [[NSData alloc] initWithBytes:responseJSON length:strlen(responseJSON)];
    NSDictionary *parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    NSDictionary *response = [parsed isKindOfClass:[NSDictionary class]]
        ? parsed
        : @{ @"ok": @NO, @"error": @"Rust SSH returned invalid JSON" };
    dispatch_async(client.rustMethodQueue, ^{
        [client completeRequest:requestID response:response];
    });
}

@implementation RNSSHRustClient

RCT_EXPORT_MODULE();

- (instancetype)init {
    self = [super init];
    if (self) {
        _rustMethodQueue = dispatch_queue_create("io.github.kaminarios.whip.rust-ssh", DISPATCH_QUEUE_SERIAL);
        _pendingCalls = [NSMutableDictionary dictionary];
        _nextRequestID = 1;
        activeRustClient = self;
    }
    return self;
}

- (dispatch_queue_t)methodQueue {
    return self.rustMethodQueue;
}

- (NSArray<NSString *> *)supportedEvents {
    return @[@"Shell", @"ShellClosed", @"DownloadProgress", @"UploadProgress",
             @"HerdrEventStream", @"HerdrCommandStream", @"HerdrBridge"];
}

- (void)startObserving {
    activeRustClient = self;
    whip_ssh_set_event_callback(whipSSHEvent);
}

- (void)stopObserving {
    whip_ssh_set_event_callback(NULL);
}

- (NSDictionary *)callOperation:(NSString *)operation params:(NSDictionary *)params {
    NSDictionary *request = @{@"operation": operation, @"params": params ?: @{}};
    NSData *requestData = [NSJSONSerialization dataWithJSONObject:request options:0 error:nil];
    NSString *requestJSON = [[NSString alloc] initWithData:requestData encoding:NSUTF8StringEncoding];
    char *responseJSON = whip_ssh_call(requestJSON.UTF8String);
    if (!responseJSON) return @{@"ok": @NO, @"error": @"Rust SSH returned no response"};
    NSData *responseData = [[NSData alloc] initWithBytes:responseJSON length:strlen(responseJSON)];
    whip_ssh_string_free(responseJSON);
    NSDictionary *response = [NSJSONSerialization JSONObjectWithData:responseData options:0 error:nil];
    return [response isKindOfClass:[NSDictionary class]]
        ? response
        : @{@"ok": @NO, @"error": @"Rust SSH returned invalid JSON"};
}

- (void)callOperationAsync:(NSString *)operation
                    params:(NSDictionary *)params
                completion:(RNSSHRustCompletion)completion {
    NSDictionary *request = @{ @"operation": operation, @"params": params ?: @{} };
    NSData *requestData = [NSJSONSerialization dataWithJSONObject:request options:0 error:nil];
    NSString *requestJSON = [[NSString alloc] initWithData:requestData encoding:NSUTF8StringEncoding];
    if (!requestJSON) {
        completion(@{ @"ok": @NO, @"error": @"Could not serialize Rust SSH request" });
        return;
    }
    uint64_t requestID = self.nextRequestID++;
    self.pendingCalls[@(requestID)] = [completion copy];
    whip_ssh_call_async(requestID, requestJSON.UTF8String, whipSSHResponse);
}

- (void)completeRequest:(uint64_t)requestID response:(NSDictionary *)response {
    RNSSHRustCompletion completion = self.pendingCalls[@(requestID)];
    if (!completion) return;
    [self.pendingCalls removeObjectForKey:@(requestID)];
    completion(response);
}

- (void)finish:(NSDictionary *)response callback:(RCTResponseSenderBlock)callback {
    if (![response[@"ok"] boolValue]) {
        callback(@[response[@"error"] ?: @"Rust SSH operation failed"]);
        return;
    }
    id value = response[@"value"];
    callback(value && value != [NSNull null] ? @[[NSNull null], value] : @[]);
}

- (void)finishAsync:(NSString *)operation
              params:(NSDictionary *)params
            callback:(RCTResponseSenderBlock)callback {
    [self callOperationAsync:operation params:params completion:^(NSDictionary *response) {
        [self finish:response callback:callback];
    }];
}

- (void)invalidate {
    whip_ssh_set_event_callback(NULL);
    if (activeRustClient == self) activeRustClient = nil;
    NSDictionary *failure = @{ @"ok": @NO, @"error": @"Rust SSH bridge was invalidated" };
    for (RNSSHRustCompletion completion in self.pendingCalls.allValues) completion(failure);
    [self.pendingCalls removeAllObjects];
    whip_ssh_shutdown();
    [super invalidate];
}

RCT_EXPORT_METHOD(setKnownHosts:(NSString *)contents) {
    [self callOperation:@"setKnownHosts" params:@{@"contents": contents ?: @""}];
}

RCT_EXPORT_METHOD(getKeyDetails:(NSString *)privateKey
                  passphrase:(NSString *)passphrase
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
    NSDictionary *params = @{
        @"privateKey": privateKey ?: @"",
        @"passphrase": passphrase ?: [NSNull null],
    };
    [self callOperationAsync:@"getKeyDetails" params:params completion:^(NSDictionary *response) {
        if ([response[@"ok"] boolValue]) resolve(response[@"value"] ?: @{});
        else reject(@"ssh_key", response[@"error"] ?: @"Could not inspect SSH key", nil);
    }];
}

RCT_EXPORT_METHOD(generateKeyPair:(NSString *)type
                  passphrase:(NSString *)passphrase
                  keySize:(NSInteger)keySize
                  comment:(NSString *)comment
                  withCallback:(RCTResponseSenderBlock)callback) {
    NSDictionary *params = @{
        @"type": type ?: @"ed25519",
        @"passphrase": passphrase ?: @"",
        @"keySize": @(keySize),
        @"comment": comment ?: @"whip",
    };
    [self finishAsync:@"generateKeyPair" params:params callback:callback];
}

RCT_EXPORT_METHOD(connectToHost:(NSString *)host
                  port:(NSInteger)port
                  withUsername:(NSString *)username
                  passwordOrKey:(id)passwordOrKey
                  withKey:(NSString *)key
                  withCallback:(RCTResponseSenderBlock)callback) {
    NSDictionary *credential;
    if ([passwordOrKey isKindOfClass:[NSString class]]) {
        credential = @{@"type": @"password", @"password": passwordOrKey};
    } else {
        credential = @{
            @"type": @"key",
            @"privateKey": passwordOrKey[@"privateKey"] ?: @"",
            @"passphrase": passwordOrKey[@"passphrase"] ?: [NSNull null],
        };
    }
    NSDictionary *params = @{
        @"host": host, @"port": @(port), @"username": username,
        @"credential": credential, @"key": key,
    };
    [self finishAsync:@"connect" params:params callback:callback];
}

- (void)connectToHost:(NSString *)host port:(NSInteger)port username:(NSString *)username
           credential:(NSDictionary *)credential jumpKey:(NSString *)jumpKey key:(NSString *)key
             callback:(RCTResponseSenderBlock)callback {
    NSMutableDictionary *params = [@{@"host": host, @"port": @(port), @"username": username,
                                     @"credential": credential, @"key": key} mutableCopy];
    if (jumpKey) params[@"jumpKey"] = jumpKey;
    [self finishAsync:@"connect" params:params callback:callback];
}

RCT_EXPORT_METHOD(connectToHostByPasswordViaJump:(NSString *)host port:(NSInteger)port
                  username:(NSString *)username password:(NSString *)password
                  jumpKey:(NSString *)jumpKey key:(NSString *)key callback:(RCTResponseSenderBlock)callback) {
    [self connectToHost:host port:port username:username
             credential:@{@"type": @"password", @"password": password}
                jumpKey:jumpKey key:key callback:callback];
}

RCT_EXPORT_METHOD(connectToHostByKeyViaJump:(NSString *)host port:(NSInteger)port
                  username:(NSString *)username keyData:(NSDictionary *)keyData
                  jumpKey:(NSString *)jumpKey key:(NSString *)key callback:(RCTResponseSenderBlock)callback) {
    [self connectToHost:host port:port username:username
             credential:@{@"type": @"key", @"privateKey": keyData[@"privateKey"] ?: @"",
                          @"passphrase": keyData[@"passphrase"] ?: [NSNull null]}
                jumpKey:jumpKey key:key callback:callback];
}

RCT_EXPORT_METHOD(setAgentForwarding:(NSString *)key enabled:(BOOL)enabled) {
    NSDictionary *response = [self callOperation:@"setAgentForwarding" params:@{@"key": key, @"enabled": @(enabled)}];
    if (![response[@"ok"] boolValue]) {
        RCTLogError(@"Could not change SSH agent forwarding: %@", response[@"error"] ?: @"unknown error");
    }
}

RCT_EXPORT_METHOD(execute:(NSString *)command
                  withKey:(NSString *)key
                  withCallback:(RCTResponseSenderBlock)callback) {
    [self callOperationAsync:@"execute" params:@{@"command": command, @"key": key}
                   completion:^(NSDictionary *response) {
        if ([response[@"ok"] boolValue]) {
            callback(@[[NSNull null], response[@"value"][@"stdout"] ?: @""]);
        } else {
            callback(@[response[@"error"] ?: @"Command failed"]);
        }
    }];
}

RCT_EXPORT_METHOD(startShell:(NSString *)key
                  ptyType:(NSString *)ptyType
                  withCallback:(RCTResponseSenderBlock)callback) {
    [self finishAsync:@"startShell" params:@{@"key": key, @"ptyType": ptyType ?: @"xterm-256color"} callback:callback];
}

RCT_EXPORT_METHOD(writeToShell:(NSString *)data
                  withKey:(NSString *)key
                  withCallback:(RCTResponseSenderBlock)callback) {
    [self finish:[self callOperation:@"writeToShell" params:@{@"key": key, @"data": data}] callback:callback];
}

RCT_EXPORT_METHOD(resizeShell:(NSInteger)columns rows:(NSInteger)rows withKey:(NSString *)key) {
    [self callOperation:@"resizeShell" params:@{@"key": key, @"columns": @(columns), @"rows": @(rows)}];
}

RCT_EXPORT_METHOD(closeShell:(NSString *)key) {
    [self callOperation:@"closeShell" params:@{@"key": key}];
}

RCT_EXPORT_METHOD(measureHostLatency:(NSString *)key withCallback:(RCTResponseSenderBlock)callback) {
    [self finishAsync:@"measureHostLatency" params:@{@"key": key} callback:callback];
}

RCT_EXPORT_METHOD(getRemoteHome:(NSString *)key withCallback:(RCTResponseSenderBlock)callback) {
    [self finishAsync:@"getRemoteHome" params:@{@"key": key} callback:callback];
}

RCT_EXPORT_METHOD(disconnect:(NSString *)key) {
    [self callOperationAsync:@"disconnect" params:@{@"key": key} completion:^(__unused NSDictionary *response) {}];
}

RCT_EXPORT_METHOD(connectSFTP:(NSString *)key withCallback:(RCTResponseSenderBlock)callback) {
    [self finishAsync:@"connectSFTP" params:@{@"key": key} callback:callback];
}

RCT_EXPORT_METHOD(sftpLs:(NSString *)path withKey:(NSString *)key withCallback:(RCTResponseSenderBlock)callback) {
    [self finishAsync:@"sftpLs" params:@{@"path": path, @"key": key} callback:callback];
}

RCT_EXPORT_METHOD(sftpMkdir:(NSString *)path withKey:(NSString *)key withCallback:(RCTResponseSenderBlock)callback) {
    [self finishAsync:@"sftpMkdir" params:@{@"path": path, @"key": key} callback:callback];
}

RCT_EXPORT_METHOD(sftpRm:(NSString *)path withKey:(NSString *)key withCallback:(RCTResponseSenderBlock)callback) {
    [self finishAsync:@"sftpRm" params:@{@"path": path, @"key": key} callback:callback];
}

RCT_EXPORT_METHOD(sftpRmdir:(NSString *)path withKey:(NSString *)key withCallback:(RCTResponseSenderBlock)callback) {
    [self finishAsync:@"sftpRmdir" params:@{@"path": path, @"key": key} callback:callback];
}

RCT_EXPORT_METHOD(sftpRename:(NSString *)oldPath newPath:(NSString *)newPath withKey:(NSString *)key withCallback:(RCTResponseSenderBlock)callback) {
    [self finishAsync:@"sftpRename" params:@{@"oldPath": oldPath, @"newPath": newPath, @"key": key} callback:callback];
}
RCT_EXPORT_METHOD(sftpChmod:(NSString *)path permissions:(NSInteger)permissions withKey:(NSString *)key withCallback:(RCTResponseSenderBlock)callback) {
    [self finishAsync:@"sftpChmod" params:@{@"path": path, @"permissions": @(permissions), @"key": key} callback:callback];
}
RCT_EXPORT_METHOD(sftpUpload:(NSString *)localPath remotePath:(NSString *)remotePath withKey:(NSString *)key withCallback:(RCTResponseSenderBlock)callback) {
    [self finishAsync:@"sftpUpload" params:@{@"localPath": localPath, @"remotePath": remotePath, @"key": key} callback:callback];
}
RCT_EXPORT_METHOD(sftpDownload:(NSString *)remotePath localPath:(NSString *)localPath withKey:(NSString *)key withCallback:(RCTResponseSenderBlock)callback) {
    [self finishAsync:@"sftpDownload" params:@{@"localPath": localPath, @"remotePath": remotePath, @"key": key} callback:callback];
}
RCT_EXPORT_METHOD(sftpCancelUpload:(NSString *)key) { [self callOperation:@"sftpCancelUpload" params:@{@"key": key}]; }
RCT_EXPORT_METHOD(sftpCancelDownload:(NSString *)key) { [self callOperation:@"sftpCancelDownload" params:@{@"key": key}]; }
RCT_EXPORT_METHOD(disconnectSFTP:(NSString *)key) {
    [self callOperationAsync:@"disconnectSFTP" params:@{@"key": key} completion:^(__unused NSDictionary *response) {}];
}

RCT_EXPORT_METHOD(prepareHerdrBridge:(NSString *)command protocol:(NSInteger)protocol
                  columns:(NSInteger)columns rows:(NSInteger)rows
                  cellWidthPx:(NSInteger)cellWidthPx cellHeightPx:(NSInteger)cellHeightPx
                  withKey:(NSString *)key withCallback:(RCTResponseSenderBlock)callback) {
    [self finishAsync:@"prepareHerdrBridge" params:@{
        @"command": command, @"protocol": @(protocol), @"columns": @(columns), @"rows": @(rows),
        @"cellWidthPx": @(cellWidthPx), @"cellHeightPx": @(cellHeightPx), @"key": key,
    } callback:callback];
}

RCT_EXPORT_METHOD(startHerdrBridge:(NSString *)socketPath protocol:(NSInteger)protocol
                  terminalId:(NSString *)terminalId takeover:(BOOL)takeover
                  columns:(NSInteger)columns rows:(NSInteger)rows
                  cellWidthPx:(NSInteger)cellWidthPx cellHeightPx:(NSInteger)cellHeightPx
                  withKey:(NSString *)key withCallback:(RCTResponseSenderBlock)callback) {
    [self finishAsync:@"startHerdrBridge" params:@{
        @"socketPath": socketPath, @"protocol": @(protocol), @"terminalId": terminalId,
        @"takeover": @(takeover), @"columns": @(columns), @"rows": @(rows),
        @"cellWidthPx": @(cellWidthPx), @"cellHeightPx": @(cellHeightPx), @"key": key,
    } callback:callback];
}

RCT_EXPORT_METHOD(herdrBridgeInput:(NSString *)terminalId text:(NSString *)text
                  withKey:(NSString *)key withCallback:(RCTResponseSenderBlock)callback) {
    [self finish:[self callOperation:@"herdrBridgeInput" params:@{
        @"terminalId": terminalId, @"text": text, @"key": key,
    }] callback:callback];
}

RCT_EXPORT_METHOD(herdrBridgeResize:(NSInteger)columns rows:(NSInteger)rows
                  cellWidthPx:(NSInteger)cellWidthPx cellHeightPx:(NSInteger)cellHeightPx
                  terminalId:(NSString *)terminalId withKey:(NSString *)key
                  withCallback:(RCTResponseSenderBlock)callback) {
    [self finish:[self callOperation:@"herdrBridgeResize" params:@{
        @"columns": @(columns), @"rows": @(rows), @"cellWidthPx": @(cellWidthPx),
        @"cellHeightPx": @(cellHeightPx), @"terminalId": terminalId, @"key": key,
    }] callback:callback];
}

RCT_EXPORT_METHOD(herdrBridgeScroll:(BOOL)up lines:(NSInteger)lines terminalId:(NSString *)terminalId
                  withKey:(NSString *)key withCallback:(RCTResponseSenderBlock)callback) {
    [self finish:[self callOperation:@"herdrBridgeScroll" params:@{
        @"up": @(up), @"lines": @(lines), @"terminalId": terminalId, @"key": key,
    }] callback:callback];
}

RCT_EXPORT_METHOD(closeHerdrBridge:(NSString *)terminalId withKey:(NSString *)key) {
    [self callOperation:@"closeHerdrBridge" params:@{@"terminalId": terminalId, @"key": key}];
}

RCT_EXPORT_METHOD(closeAllHerdrBridges:(NSString *)key) {
    [self callOperation:@"closeAllHerdrBridges" params:@{@"key": key}];
}

RCT_EXPORT_METHOD(openLocalForward:(NSString *)remoteHost remotePort:(NSInteger)remotePort withKey:(NSString *)key withCallback:(RCTResponseSenderBlock)callback) {
    [self finishAsync:@"openLocalForward" params:@{@"remoteHost": remoteHost, @"remotePort": @(remotePort), @"key": key} callback:callback];
}
RCT_EXPORT_METHOD(closeLocalForward:(NSInteger)localPort withKey:(NSString *)key withCallback:(RCTResponseSenderBlock)callback) {
    [self finish:[self callOperation:@"closeLocalForward" params:@{@"localPort": @(localPort), @"key": key}] callback:callback];
}

RCT_EXPORT_METHOD(requestHerdrApi:(NSString *)socketPath request:(NSString *)request withKey:(NSString *)key withCallback:(RCTResponseSenderBlock)callback) {
    [self finishAsync:@"requestHerdrApi" params:@{@"socketPath": socketPath, @"request": request, @"key": key} callback:callback];
}
RCT_EXPORT_METHOD(startHerdrEventStream:(NSString *)socketPath withKey:(NSString *)key withCallback:(RCTResponseSenderBlock)callback) {
    [self finishAsync:@"startHerdrEventStream" params:@{@"socketPath": socketPath, @"key": key} callback:callback];
}
RCT_EXPORT_METHOD(writeHerdrEventStream:(NSString *)value withKey:(NSString *)key withCallback:(RCTResponseSenderBlock)callback) {
    [self finish:[self callOperation:@"writeHerdrEventStream" params:@{@"value": value, @"key": key}] callback:callback];
}
RCT_EXPORT_METHOD(closeHerdrEventStream:(NSString *)key) { [self callOperation:@"closeHerdrEventStream" params:@{@"key": key}]; }
RCT_EXPORT_METHOD(startHerdrCommandStream:(NSString *)command withKey:(NSString *)key withCallback:(RCTResponseSenderBlock)callback) {
    [self finishAsync:@"startHerdrCommandStream" params:@{@"command": command, @"key": key} callback:callback];
}
RCT_EXPORT_METHOD(writeHerdrCommandStream:(NSString *)value withKey:(NSString *)key withCallback:(RCTResponseSenderBlock)callback) {
    [self finish:[self callOperation:@"writeHerdrCommandStream" params:@{@"value": value, @"key": key}] callback:callback];
}
RCT_EXPORT_METHOD(closeHerdrCommandStream:(NSString *)key) { [self callOperation:@"closeHerdrCommandStream" params:@{@"key": key}]; }

@end
