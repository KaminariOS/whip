#import <React/RCTUtils.h>
#import "RNSSHClient.h"
#import "SSHClient.h"

@implementation RNSSHClient {
    NSMutableDictionary* _clientPool;
}

RCT_EXPORT_MODULE();

- (dispatch_queue_t)methodQueue
{
    return dispatch_queue_create("reactnative.sshclient", DISPATCH_QUEUE_SERIAL);
}

- (NSArray<NSString *> *)supportedEvents
{
    return @[@"Shell", @"DownloadProgress", @"UploadProgress"];
}

- (NSMutableDictionary*) clientPool {
    if (!_clientPool) {
        _clientPool = [NSMutableDictionary new];
    }
    return _clientPool;
}

- (SSHClient*) clientForKey:(nonnull NSString*)key {
    return [[self clientPool] objectForKey:key];
}

- (BOOL)isConnected:(NMSSHSession *)session
       withCallback:(RCTResponseSenderBlock)callback {
    if (session && session.isConnected && session.isAuthorized) {
        return true;
    } else {
        NSLog(@"Session not connected");
        callback(@[@"Session not connected"]);
        return false;
    }
}

- (BOOL)isSFTPConnected:(NMSFTP *)sftpSesion
           withCallback:(RCTResponseSenderBlock)callback {
    if (sftpSesion) {
        return true;
    } else {
        NSLog(@"SFTP not connected");
        callback(@[@"SFTP not connected"]);
        return false;
    }
}

RCT_EXPORT_METHOD(connectToHost:(NSString *)host
                  port:(NSInteger)port
                  withUsername:(NSString *)username
                  passwordOrKey:(id) passwordOrKey // password or {privateKey: value, [publicKey: value, passphrase: value]}
                  withKey:(nonnull NSString*)key
                  withCallback:(RCTResponseSenderBlock)callback){
    // Run the entire connection + authentication on a single background thread.
    // NMSSH is not thread-safe: all operations on a session must happen on the
    // same thread that created it.
    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        NMSSHSession* session = [NMSSHSession connectToHost:host
                                                       port:port
                                               withUsername:username];
        if (!session) {
            NSLog(@"Connection to host %@ failed", host);
            callback(@[[NSString stringWithFormat:@"Connection to host %@ failed, without session", host]]);
            return;
        }

        if (!session.isConnected) {
            NSLog(@"Connection to host %@ failed", host);
            callback(@[[NSString stringWithFormat:@"Connection to host %@ failed, with session", host]]);
            return;
        }

        if ([passwordOrKey isKindOfClass:[NSString class]])
            [session authenticateByPassword:passwordOrKey];
        else
            [session authenticateByInMemoryPublicKey:[passwordOrKey objectForKey:@"publicKey"] privateKey:[passwordOrKey objectForKey:@"privateKey"] andPassword:[passwordOrKey objectForKey:@"passphrase"]];

        if (!session.isAuthorized) {
            NSLog(@"Authentication failed");
            callback(@[[NSString stringWithFormat:@"Authentication to host %@ failed", host]]);
            return;
        }

        SSHClient* client = [[SSHClient alloc] init];
        client._session = session;
        client._key = key;
        [[self clientPool] setObject:client forKey:key];
        NSLog(@"Session connected");
        callback(@[]);
    });
}

RCT_EXPORT_METHOD(execute:(NSString *)command
                  withKey:(nonnull NSString*)key
                  withCallback:(RCTResponseSenderBlock)callback) {
    SSHClient* client = [self clientForKey:key];
    if (client) {
        NMSSHSession* session = client._session;
        if ([self isConnected:session withCallback:callback]) {
            // Run the blocking execute (up to a 10s timeout) on a background queue
            // so it doesn't stall the serial method queue and block other SSH
            // operations, consistent with startShell/writeToShell (review #8).
            dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
                NSError* error = nil;
                NSString* response = [session.channel execute:command error:&error timeout:@10];
                if (error) {
                    NSLog(@"Error executing command: %@", error);
                    callback(@[RCTJSErrorFromNSError(error)]);
                } else {
                    callback(@[[NSNull null], response]);
                }
            });
        }
    } else {
        callback(@[@"Unknown client"]);
    }
}

RCT_EXPORT_METHOD(startShell:(nonnull NSString*)key
                  ptyType:(NSString *)ptyType // vanilla, vt100, vt102, vt220, ansi, xterm
                  withCallback:(RCTResponseSenderBlock)callback) {
    SSHClient* client = [self clientForKey:key];
    if (client) {
        client.delegate = self;
//        NSError* error = nil;
        __block NSError *error = nil;
        dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
            [client startShell:ptyType error:&error];
            if (error) {
                NSLog(@"Error starting shell: %@", error);
                callback(@[RCTJSErrorFromNSError(error)]);
            } else {
                callback(@[]);
            }
        });
    } else {
        callback(@[@"Unknown client"]);
    }
}

RCT_EXPORT_METHOD(writeToShell:(NSString *)command
                  withKey:(nonnull NSString*)key
                  withCallback:(RCTResponseSenderBlock)callback) {
    SSHClient* client = [self clientForKey:key];
    if (client) {
        if ([self isConnected:client._session withCallback:callback]) {
            dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
                NSError* error = nil;
                [client._session.channel write:command error:&error timeout:@10];
                if (error) {
                    NSLog(@"Error writing to shell: %@", error);
                    callback(@[RCTJSErrorFromNSError(error)]);
                } else {
                    callback(@[]);
                }
            });
        }
    } else {
        callback(@[@"Unknown client"]);
    }
}

- (void) shellEvent:(NSString *)event withKey:(NSString *)key {
    [self sendEventWithName:@"Shell" body:@{@"name": @"Shell", @"key": key, @"value": event}];
}

RCT_EXPORT_METHOD(closeShell:(nonnull NSString*)key) {
    SSHClient* client = [self clientForKey:key];
    if (client && client._session && client._session.channel) {
        [client._session.channel closeShell];
    }
}

RCT_EXPORT_METHOD(connectSFTP:(nonnull NSString*)key
                  withCallback:(RCTResponseSenderBlock)callback) {
    SSHClient* client = [self clientForKey:key];
    if (client) {
        if ([self isConnected:client._session withCallback:callback]) {
            dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
                NMSFTP* sftpSession = [NMSFTP connectWithSession:client._session];
                if (sftpSession) {
                    client._sftpSession = sftpSession;
                    callback(@[]);
                } else {
                    callback(@[@"Failed to connect SFTP"]);
                }
            });
        }
    } else {
        callback(@[@"Unknown client"]);
    }
}

RCT_EXPORT_METHOD(sftpLs:(NSString *)path
                  withKey:(nonnull NSString*)key
                  withCallback:(RCTResponseSenderBlock)callback) {
    SSHClient* client = [self clientForKey:key];
    if (client) {
        if ([self isConnected:client._session withCallback:callback] &&
            [self isSFTPConnected:client._sftpSession withCallback:callback]) {

            dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
                NSArray* fileList = [client._sftpSession contentsOfDirectoryAtPath:path];
                if (fileList) {
                    NSMutableArray* array = [NSMutableArray array];
                    for (NMSFTPFile* file in fileList) {
                        // Serialize each entry with NSJSONSerialization so filenames
                        // containing quotes, backslashes, control characters, or unicode
                        // are escaped correctly. Manual stringWithFormat: produced invalid
                        // JSON that crashed JSON.parse on the JS side (review #7). Field
                        // types match the previous output: dates/permissions are strings,
                        // isDirectory is a 0/1 integer, the rest are numbers.
                        NSDictionary* entry = @{
                            @"filename": file.filename ?: @"",
                            @"isDirectory": @((int)file.isDirectory),
                            @"modificationDate": file.modificationDate ? [file.modificationDate description] : @"",
                            @"lastAccess": file.lastAccess ? [file.lastAccess description] : @"",
                            @"fileSize": file.fileSize ?: @0,
                            @"ownerUserID": @(file.ownerUserID),
                            @"ownerGroupID": @(file.ownerGroupID),
                            @"permissions": file.permissions ?: @"",
                            @"flags": @(file.flags)
                        };
                        NSError* jsonError = nil;
                        NSData* jsonData = [NSJSONSerialization dataWithJSONObject:entry options:0 error:&jsonError];
                        if (jsonData) {
                            [array addObject:[[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding]];
                        } else {
                            NSLog(@"Failed to serialize file entry: %@", jsonError);
                        }
                    }
                    callback(@[[NSNull null], array]);
                } else {
                    callback(@[[NSString stringWithFormat:@"Failed to list path  %@",path]]);
                }
            });
        } else {
            callback(@[@"Unknown client"]);
        }
    }
}

RCT_EXPORT_METHOD(sftpRename:(NSString *)oldPath
                  newPath:(NSString *)newPath
                  withKey:(nonnull NSString*)key
                  withCallback:(RCTResponseSenderBlock)callback){
    SSHClient* client = [self clientForKey:key];
    if (client) {
        if ([self isConnected:client._session withCallback:callback] &&
            [self isSFTPConnected:client._sftpSession withCallback:callback]) {
            if ([client._sftpSession moveItemAtPath:oldPath toPath:newPath]) {
                callback(@[]);
            } else {
                callback(@[[NSString stringWithFormat:@"Failed to rename path %@ to %@", oldPath, newPath]]);
            }
        }
    } else {
        callback(@[@"Unknown client"]);
    }
}

RCT_EXPORT_METHOD(sftpMkdir:(NSString *)path
                  withKey:(nonnull NSString*)key
                  withCallback:(RCTResponseSenderBlock)callback){
    SSHClient* client = [self clientForKey:key];
    if (client) {
        if ([self isConnected:client._session withCallback:callback] &&
            [self isSFTPConnected:client._sftpSession withCallback:callback]) {
            if([client._sftpSession createDirectoryAtPath:path]) {
                callback(@[]);
            } else {
                callback(@[[NSString stringWithFormat:@"Failed to create directory %@", path]]);
            }
        }
    } else {
        callback(@[@"Unknown client"]);
    }
}

RCT_EXPORT_METHOD(sftpRm:(NSString *)path
                  withKey:(nonnull NSString*)key
                  withCallback:(RCTResponseSenderBlock)callback) {
    SSHClient* client = [self clientForKey:key];
    if (client) {
        if ([self isConnected:client._session withCallback:callback] &&
            [self isSFTPConnected:client._sftpSession withCallback:callback]) {
            if([client._sftpSession removeFileAtPath:path]) {
                callback(@[]);
            } else {
                callback(@[[NSString stringWithFormat:@"Failed to remove %@", path]]);
            }
        }
    } else {
        callback(@[@"Unknown client"]);
    }
}

RCT_EXPORT_METHOD(sftpRmdir:(NSString *)path
                  withKey:(nonnull NSString*)key
                  withCallback:(RCTResponseSenderBlock)callback) {
    SSHClient* client = [self clientForKey:key];
    if (client) {
        if ([self isConnected:client._session withCallback:callback] &&
            [self isSFTPConnected:client._sftpSession withCallback:callback]) {
            if([client._sftpSession removeDirectoryAtPath:path]) {
                callback(@[]);
            } else {
                callback(@[[NSString stringWithFormat:@"Failed to remove %@", path]]);
            }
        }
    } else {
        callback(@[@"Unknown client"]);
    }
}

RCT_EXPORT_METHOD(sftpChmod:(NSString *)path
                  withPermissions:(NSInteger)permissions
                  withKey:(nonnull NSString*) key
                  withCallback:(RCTResponseSenderBlock)callback) {
    callback(@[@"Not implemented"]);
}

RCT_EXPORT_METHOD(sftpDownload:(NSString *)path
                  toPath:(NSString *)toPath
                  withKey:(nonnull NSString*)key
                  withCallback:(RCTResponseSenderBlock)callback) {
    SSHClient* client = [self clientForKey:key];
    if (client) {
        if ([self isConnected:client._session withCallback:callback] &&
            [self isSFTPConnected:client._sftpSession withCallback:callback]) {
//            NSArray* paths = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
//            NSString* documentsDirectory = [paths objectAtIndex:0];
//            NSString* filePath = [NSString stringWithFormat:@"%@/%@", documentsDirectory, [path lastPathComponent]];
            NSString* filePath = [NSString stringWithFormat:@"%@%@", toPath, [path lastPathComponent]];

            NSLog(@"%@", filePath);

            dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
                client.delegate = self;
                NSError* error = nil;
                [client sftpDownload:path toPath:filePath error:&error];
                if (error) {
                    callback(@[RCTJSErrorFromNSError(error)]);
                } else if (client._downloadContinue) {
                    callback(@[[NSNull null], filePath]);
                } else {
                    callback(@[@"Download canceled"]);
                }
            });
        }
    } else {
        callback(@[@"Unknown client"]);
    }
}

- (void) downloadProgressEvent:(int)event withKey:(NSString *)key {
    [self sendEventWithName:@"DownloadProgress" body:@{@"name": @"DownloadProgress", @"key": key, @"value": [NSString stringWithFormat:@"%d", event]}];
}

RCT_EXPORT_METHOD(sftpCancelDownload:(nonnull NSString*)key) {
    SSHClient* client = [self clientForKey:key];
    if (client) {
        client._downloadContinue = false;
    }
}

RCT_EXPORT_METHOD(sftpUpload:(NSString *)filePath
                  toPath:(NSString *)path
                  withKey:(nonnull NSString*)key
                  withCallback:(RCTResponseSenderBlock)callback) {
    SSHClient* client = [self clientForKey:key];
    if (client) {
        if ([self isConnected:client._session withCallback:callback] &&
            [self isSFTPConnected:client._sftpSession withCallback:callback]) {
            dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
                client.delegate = self;
                BOOL result = [client sftpUpload:filePath toPath:path];
                if (result) {
                    callback(@[]);
                } else {
                    if (client._uploadContinue) {
                        NSLog(@"Error uploading file");
                        callback(@[[NSString stringWithFormat:@"Failed to upload %@ to %@", filePath, path]]);
                    } else {
                        callback(@[@"Upload canceled"]);
                    }
                }
            });
        }
    } else {
        callback(@[@"Unknown client"]);
    }
}

- (void) uploadProgressEvent:(int)event withKey:(NSString *)key {
    [self sendEventWithName:@"UploadProgress" body:@{@"name": @"UploadProgress", @"key": key, @"value": [NSString stringWithFormat:@"%d", event]}];
}

RCT_EXPORT_METHOD(sftpCancelUpload:(nonnull NSString*)key) {
    SSHClient* client = [self clientForKey:key];
    if (client) {
        client._uploadContinue = false;
    }
}

RCT_EXPORT_METHOD(disconnectSFTP:(nonnull NSString*)key) {
    SSHClient* client = [self clientForKey:key];
    if (client && client._sftpSession) {
        [client._sftpSession disconnect];
    }
}

RCT_EXPORT_METHOD(disconnect:(nonnull NSString*)key) {
    [self closeShell:key];
    [self disconnectSFTP:key];
    SSHClient* client = [self clientForKey:key];
    if (client && client._session) {
        [client._session disconnect];
    }
    // Remove the client from the pool so it can be released. Without this the
    // pool grows unbounded for apps that open many short-lived connections.
    [[self clientPool] removeObjectForKey:key];
}

@end
