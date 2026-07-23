import { Platform, NativeModules, NativeEventEmitter, DeviceEventEmitter } from 'react-native';
const { RNSSHClient } = NativeModules;
const RNSSHClientEmitter = new NativeEventEmitter(RNSSHClient);
const NATIVE_EVENT_SHELL = 'Shell';
const NATIVE_EVENT_HERDR_BRIDGE = 'HerdrBridge';
const NATIVE_EVENT_HERDR_EVENT_STREAM = 'HerdrEventStream';
const NATIVE_EVENT_HERDR_COMMAND_STREAM = 'HerdrCommandStream';
const NATIVE_EVENT_DOWNLOAD_PROGRESS = 'DownloadProgress';
const NATIVE_EVENT_UPLOAD_PROGRESS = 'UploadProgress';
/**
 * Represents the types of PTY (pseudo-terminal) for SSH connections.
 */
export var PtyType;
(function (PtyType) {
    PtyType["VANILLA"] = "vanilla";
    PtyType["VT100"] = "vt100";
    PtyType["VT102"] = "vt102";
    PtyType["VT220"] = "vt220";
    PtyType["ANSI"] = "ansi";
    PtyType["XTERM"] = "xterm";
})(PtyType || (PtyType = {}));
/**
 * Represents an SSH client that can connect to a remote server and perform various operations.
 * Instances of SSHClient are created using the following factory functions:
 * - SSHClient.connectWithKey()
 * - SSHClient.connectWithPassword()
 */
class SSHClient {
    /**
    * Retrieves the details of an SSH key.
    * @param key - The SSH private key as a string.
    * @param passphrase - The passphrase for an encrypted private key (optional).
    * @returns A Promise that resolves to the details of the key, including its fingerprint, type and size.
    */
    static getKeyDetails(key, passphrase) {
        return new Promise((resolve, reject) => {
            RNSSHClient.getKeyDetails(key, passphrase || null)
                .then((result) => {
                resolve({
                    keyType: result.keyType,
                    keySize: result.keySize || 0,
                    fingerprint: result.fingerprint,
                    publicKey: result.publicKey
                });
            })
                .catch((error) => {
                reject(error);
            });
        });
    }
    static generateKeyPair(type, passphrase, keySize, comment) {
        return new Promise((resolve, reject) => {
            RNSSHClient.generateKeyPair(type, passphrase, keySize, comment, (error, keys) => {
                if (error) {
                    reject(error);
                }
                else {
                    resolve({
                        privateKey: keys.privateKey,
                        publicKey: keys.publicKey,
                    });
                }
            });
        });
    }
    /**
     * Connects to an SSH server using a private key for authentication.
     *
     * @param host - The hostname or IP address of the SSH server.
     * @param port - The port number of the SSH server.
     * @param username - The username for authentication.
     * @param privateKey - The private key for authentication.
     * @param passphrase - The passphrase for the private key (optional).
     * @param callback - A callback function to handle the connection result (optional).
     *
     * @returns A Promise that resolves to an instance of SSHClient if the connection is successful.
     *          Otherwise, it rejects with an error.
     */
    static connectWithKey(host, port, username, privateKey, passphrase, callback) {
        return new Promise((resolve, reject) => {
            const result = new SSHClient(host, port, username, { privateKey, passphrase }, (error) => {
                if (callback) {
                    callback(error);
                }
                if (error) {
                    return reject(error);
                }
                resolve(result);
            });
        });
    }
    /**
     * Connects to an SSH server using password authentication.
     *
     * @param host - The hostname or IP address of the SSH server.
     * @param port - The port number of the SSH server.
     * @param username - The username for authentication.
     * @param password - The password for authentication.
     * @param callback - Optional callback function to handle any errors during the connection process.
     * @returns A Promise that resolves to an instance of SSHClient if the connection is successful.
     * @throws If there is an error during the connection process.
     */
    static connectWithPassword(host, port, username, password, callback) {
        return new Promise((resolve, reject) => {
            const result = new SSHClient(host, port, username, password, (error) => {
                if (callback) {
                    callback(error);
                }
                if (error) {
                    return reject(error);
                }
                resolve(result);
            });
        });
    }
    /**
     * Creates a new SSHClient instance.
     * Should not be called directly; use the `connectWithKey` or `connectWithPassword` factory functions instead.
     * @param host The hostname or IP address of the SSH server.
     * @param port The port number of the SSH server.
     * @param username The username for authentication.
     * @param passwordOrKey The password or private key for authentication.
     * @param callback The callback function to be called after the connection is established.
     */
    constructor(host, port, username, passwordOrKey, callback) {
        this._key = SSHClient.getRandomClientKey();
        this._listeners = {};
        this._counters = {
            download: 0,
            upload: 0,
        };
        this._activeStream = {
            sftp: false,
            shell: false,
            herdrEventStream: false,
            herdrCommandStream: false,
        };
        this._handlers = {};
        this._herdrBridgeHandlers = new Map();
        this.host = host;
        this.port = port;
        this.username = username;
        this.connect(passwordOrKey, callback);
    }
    /**
     * Generates a unique client key, used to identify which native callback and
     * event belongs to which instance.
     *
     * Combines a timestamp, a process-lifetime monotonic counter, and a small
     * random suffix. The counter guarantees uniqueness for clients created within
     * the same millisecond, which the previous 16-bit random-only approach could
     * not (it had a realistic collision risk across many connections).
     *
     * @returns A string uniquely identifying the client instance.
     */
    static getRandomClientKey() {
        const random = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
        return `ssh_${Date.now().toString(36)}_${(++SSHClient._keyCounter).toString(36)}_${random}`;
    }
    /**
     * Handles a native event (callback).
     *
     * @param event The native event to handle.
     */
    handleEvent(event) {
        if (event.name === NATIVE_EVENT_HERDR_BRIDGE && this._key === event.key) {
            const terminalId = event.value?.terminalId;
            const handler = terminalId ? this._herdrBridgeHandlers.get(terminalId) : undefined;
            if (handler) {
                handler(event.value);
            }
            if (terminalId && event.value?.type === 'closed') {
                this._herdrBridgeHandlers.delete(terminalId);
                if (this._herdrBridgeHandlers.size === 0) {
                    this.unregisterNativeListener(NATIVE_EVENT_HERDR_BRIDGE);
                }
            }
            return;
        }
        if (event.name === NATIVE_EVENT_HERDR_EVENT_STREAM && event.value?.includes?.('herdr_android_bridge_closed')) {
            this._activeStream.herdrEventStream = false;
        }
        if (event.name === NATIVE_EVENT_HERDR_COMMAND_STREAM && event.value?.closed) {
            this._activeStream.herdrCommandStream = false;
        }
        if (this._handlers[event.name] && this._key === event.key) {
            this._handlers[event.name](event.value);
        }
    }
    /**
     * Registers an event handler for the specified event.
     *
     * @param eventName - The name of the event.
     * @param handler - The event handler function.
     */
    on(eventName, handler) {
        this._handlers[eventName] = handler;
    }
    /**
     * Removes the handler registered for the specified event, if any.
     *
     * Handlers registered via {@link on} otherwise persist until replaced; use this
     * to cleanly tear down a subscription (for example in a component's unmount).
     *
     * @param eventName - The name of the event whose handler should be removed.
     */
    off(eventName) {
        delete this._handlers[eventName];
    }
    /**
     * Removes the handler registered for the specified event, if any.
     *
     * Alias for {@link off}, provided for familiarity with the event-emitter naming
     * convention.
     *
     * @param eventName - The name of the event whose handler should be removed.
     */
    removeListener(eventName) {
        this.off(eventName);
    }
    /**
     * Registers a native listener for the specified event name.
     *
     * @param eventName - The name of the event to listen for.
     */
    registerNativeListener(eventName) {
        const listenerInterface = Platform.OS === 'ios' ? RNSSHClientEmitter : DeviceEventEmitter;
        this._listeners[eventName] = listenerInterface.addListener(eventName, this.handleEvent.bind(this));
    }
    /**
     * Unregisters a native listener for the specified event name.
     * @param eventName - The name of the event.
     */
    unregisterNativeListener(eventName) {
        const listener = this._listeners[eventName];
        if (listener) {
            listener.remove();
            delete this._listeners[eventName];
        }
    }
    /**
     * Connects to the SSH server using the provided password or key.
     *
     * @param passwordOrKey - The password or key to authenticate with the server.
     * @param callback - The callback function to be called after the connection attempt.
     */
    connect(passwordOrKey, callback) {
        if (Platform.OS === 'android') {
            if (typeof passwordOrKey === 'string') {
                RNSSHClient.connectToHostByPassword(this.host, this.port, this.username, passwordOrKey, this._key, (error) => { callback(error); });
            }
            else {
                RNSSHClient.connectToHostByKey(this.host, this.port, this.username, passwordOrKey, this._key, (error) => { callback(error); });
            }
            return;
        }
        // iOS...
        RNSSHClient.connectToHost(this.host, this.port, this.username, passwordOrKey, this._key, (error) => { callback(error); });
    }
    /**
     * Executes a command on the SSH server.
     * @param command The command to execute.
     * @param callback Optional callback function to handle the result asynchronously.
     * @returns A promise that resolves with the response from the server.
     */
    execute(command, callback) {
        return new Promise((resolve, reject) => {
            RNSSHClient.execute(command, this._key, (error, response) => {
                if (callback) {
                    callback(error, response);
                }
                if (error) {
                    return reject(error);
                }
                resolve(response);
            });
        });
    }
    /**
     * Starts a shell session on the SSH server.
     * @param ptyType - The type of pseudo-terminal to use for the shell session.
     * @param callback - Optional callback function to handle the response.
     * @returns A promise that resolves with the response from the server.
     */
    startShell(ptyType, callback) {
        if (this._activeStream.shell) {
            return Promise.resolve('');
        }
        return new Promise((resolve, reject) => {
            this.registerNativeListener(NATIVE_EVENT_SHELL);
            RNSSHClient.startShell(this._key, ptyType, (error, response) => {
                if (callback) {
                    callback(error, response);
                }
                if (error) {
                    return reject(error);
                }
                this._activeStream.shell = true;
                resolve(response);
            });
        });
    }
    /**
     * Starts a shell whose native events are emitted one complete line at a time.
     *
     * This is intended for newline-delimited application protocols. A large
     * record must cross the React Native event bridge atomically; splitting one
     * JSON record into many DeviceEventEmitter events can leave the receiver
     * with an unusable partial initial snapshot when the bridge is busy.
     */
    startLineShell(ptyType, callback) {
        if (Platform.OS !== 'android') {
            return this.startShell(ptyType, callback);
        }
        if (this._activeStream.shell) {
            return Promise.resolve('');
        }
        return new Promise((resolve, reject) => {
            this.registerNativeListener(NATIVE_EVENT_SHELL);
            RNSSHClient.startLineShell(this._key, ptyType, (error, response) => {
                if (callback) {
                    callback(error, response);
                }
                if (error) {
                    return reject(error);
                }
                this._activeStream.shell = true;
                resolve(response);
            });
        });
    }
    /**
     * Checks if the shell is active. If the shell is already active, it returns an empty string.
     * Otherwise, it starts a new shell and returns the result.
     * @param callback Optional callback function to handle errors.
     * @returns A promise that resolves to a string representing the result of the shell check.
     */
    checkShell(callback) {
        if (this._activeStream.shell) {
            return Promise.resolve('');
        }
        return this.startShell(PtyType.VANILLA)
            .then((res) => (res ? res + '\n' : ''))
            .catch((error) => {
            if (callback) {
                callback(error);
            }
            throw error;
        });
    }
    /**
     * Writes a command to the shell.
     * @param command - The command to write to the shell.
     * @param callback - Optional callback function to handle the response.
     * @returns A promise that resolves with the response from the shell.
     */
    writeToShell(command, callback) {
        return this.checkShell(callback)
            .then(() => new Promise((resolve, reject) => {
            RNSSHClient.writeToShell(command, this._key, (error, response) => {
                if (callback) {
                    callback(error, response);
                }
                if (error) {
                    return reject(error);
                }
                resolve(response);
            });
        }));
    }
    resizeShell(columns, rows) {
        RNSSHClient.resizeShell(columns, rows, this._key);
    }
    /**
     * Closes the SSH shell.
     */
    closeShell() {
        this.unregisterNativeListener(NATIVE_EVENT_SHELL);
        // TODO this should use a callback too
        RNSSHClient.closeShell(this._key);
        this._activeStream.shell = false;
    }
    prepareHerdrBridge(command, protocol, columns, rows, cellWidthPx, cellHeightPx, callback) {
        if (Platform.OS !== 'android') {
            return Promise.reject(new Error('Herdr remote-client-bridge is currently Android-only'));
        }
        return new Promise((resolve, reject) => {
            RNSSHClient.prepareHerdrBridge(command, protocol, columns, rows, cellWidthPx, cellHeightPx, this._key, error => {
                if (callback) callback(error);
                if (error) return reject(error);
                resolve();
            });
        });
    }
    startHerdrBridge(socketPath, protocol, terminalId, takeover, columns, rows, cellWidthPx, cellHeightPx, handler, callback) {
        if (Platform.OS !== 'android') {
            return Promise.reject(new Error('Herdr remote-client-bridge is currently Android-only'));
        }
        if (this._herdrBridgeHandlers.has(terminalId)) {
            this._herdrBridgeHandlers.set(terminalId, handler);
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            this._herdrBridgeHandlers.set(terminalId, handler);
            if (!this._listeners[NATIVE_EVENT_HERDR_BRIDGE]) {
                this.registerNativeListener(NATIVE_EVENT_HERDR_BRIDGE);
            }
            RNSSHClient.startHerdrBridge(socketPath, protocol, terminalId, takeover, columns, rows, cellWidthPx, cellHeightPx, this._key, (error) => {
                if (callback) callback(error);
                if (error) {
                    this._herdrBridgeHandlers.delete(terminalId);
                    if (this._herdrBridgeHandlers.size === 0) {
                        this.unregisterNativeListener(NATIVE_EVENT_HERDR_BRIDGE);
                    }
                    return reject(error);
                }
                resolve();
            });
        });
    }
    herdrBridgeInput(terminalId, text) {
        return new Promise((resolve, reject) => {
            RNSSHClient.herdrBridgeInput(terminalId, text, this._key, error => error ? reject(error) : resolve());
        });
    }
    herdrBridgeResize(terminalId, columns, rows, cellWidthPx = 0, cellHeightPx = 0) {
        return new Promise((resolve, reject) => {
            RNSSHClient.herdrBridgeResize(columns, rows, cellWidthPx, cellHeightPx, terminalId, this._key, error => error ? reject(error) : resolve());
        });
    }
    herdrBridgeScroll(terminalId, direction, lines) {
        return new Promise((resolve, reject) => {
            RNSSHClient.herdrBridgeScroll(direction === 'up', lines, terminalId, this._key, error => error ? reject(error) : resolve());
        });
    }
    closeHerdrBridge(terminalId) {
        this._herdrBridgeHandlers.delete(terminalId);
        RNSSHClient.closeHerdrBridge(terminalId, this._key);
        if (this._herdrBridgeHandlers.size === 0) {
            this.unregisterNativeListener(NATIVE_EVENT_HERDR_BRIDGE);
        }
    }
    closeAllHerdrBridges() {
        this._herdrBridgeHandlers.clear();
        this.unregisterNativeListener(NATIVE_EVENT_HERDR_BRIDGE);
        RNSSHClient.closeAllHerdrBridges(this._key);
    }
    openLocalForward(remoteHost, remotePort) {
        if (Platform.OS !== 'android') {
            return Promise.reject(new Error('SSH local forwarding is currently Android-only'));
        }
        return new Promise((resolve, reject) => {
            RNSSHClient.openLocalForward(remoteHost, remotePort, this._key, (error, localPort) => error ? reject(error) : resolve(localPort));
        });
    }
    closeLocalForward(localPort) {
        if (Platform.OS !== 'android') return Promise.resolve();
        return new Promise((resolve, reject) => {
            RNSSHClient.closeLocalForward(localPort, this._key, error => error ? reject(error) : resolve());
        });
    }
    startHerdrEventStream(socketPath, handler, callback) {
        if (Platform.OS !== 'android') {
            return Promise.reject(new Error('Herdr event streams are currently Android-only'));
        }
        if (this._activeStream.herdrEventStream) {
            this.on(NATIVE_EVENT_HERDR_EVENT_STREAM, handler);
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            this.on(NATIVE_EVENT_HERDR_EVENT_STREAM, handler);
            this.registerNativeListener(NATIVE_EVENT_HERDR_EVENT_STREAM);
            RNSSHClient.startHerdrEventStream(socketPath, this._key, error => {
                if (callback) callback(error);
                if (error) {
                    this.off(NATIVE_EVENT_HERDR_EVENT_STREAM);
                    this.unregisterNativeListener(NATIVE_EVENT_HERDR_EVENT_STREAM);
                    return reject(error);
                }
                this._activeStream.herdrEventStream = true;
                resolve();
            });
        });
    }
    writeHerdrEventStream(value) {
        return new Promise((resolve, reject) => {
            RNSSHClient.writeHerdrEventStream(value, this._key, error => error ? reject(error) : resolve());
        });
    }
    closeHerdrEventStream() {
        this.off(NATIVE_EVENT_HERDR_EVENT_STREAM);
        this.unregisterNativeListener(NATIVE_EVENT_HERDR_EVENT_STREAM);
        RNSSHClient.closeHerdrEventStream(this._key);
        this._activeStream.herdrEventStream = false;
    }
    requestHerdrApi(socketPath, request) {
        if (Platform.OS !== 'android') {
            return Promise.reject(new Error('Direct Herdr API requests are currently Android-only'));
        }
        return new Promise((resolve, reject) => {
            RNSSHClient.requestHerdrApi(socketPath, request, this._key, (error, response) => error ? reject(error) : resolve(response));
        });
    }
    getRemoteHome() {
        if (Platform.OS !== 'android') {
            return Promise.reject(new Error('Remote home discovery is currently Android-only'));
        }
        return new Promise((resolve, reject) => {
            RNSSHClient.getRemoteHome(this._key, (error, home) => error ? reject(error) : resolve(home));
        });
    }
    startHerdrCommandStream(command, handler, callback) {
        if (Platform.OS !== 'android') {
            return Promise.reject(new Error('Herdr command streams are currently Android-only'));
        }
        if (this._activeStream.herdrCommandStream) {
            this.on(NATIVE_EVENT_HERDR_COMMAND_STREAM, handler);
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            this.on(NATIVE_EVENT_HERDR_COMMAND_STREAM, handler);
            this.registerNativeListener(NATIVE_EVENT_HERDR_COMMAND_STREAM);
            RNSSHClient.startHerdrCommandStream(command, this._key, error => {
                if (callback) callback(error);
                if (error) {
                    this.off(NATIVE_EVENT_HERDR_COMMAND_STREAM);
                    this.unregisterNativeListener(NATIVE_EVENT_HERDR_COMMAND_STREAM);
                    return reject(error);
                }
                this._activeStream.herdrCommandStream = true;
                resolve();
            });
        });
    }
    writeHerdrCommandStream(value) {
        return new Promise((resolve, reject) => {
            RNSSHClient.writeHerdrCommandStream(value, this._key, error => error ? reject(error) : resolve());
        });
    }
    closeHerdrCommandStream() {
        this.off(NATIVE_EVENT_HERDR_COMMAND_STREAM);
        this.unregisterNativeListener(NATIVE_EVENT_HERDR_COMMAND_STREAM);
        RNSSHClient.closeHerdrCommandStream(this._key);
        this._activeStream.herdrCommandStream = false;
    }
    /**
     * Connects to the SFTP server.
     *
     * It is not mandatory to call this method before calling any SFTP method.
     * @param callback - Optional callback function to be called after the connection is established.
     * @returns A promise that resolves when the connection is established successfully, or rejects with an error if the connection fails.
     */
    connectSFTP(callback) {
        if (this._activeStream.sftp) {
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            RNSSHClient.connectSFTP(this._key, (error) => {
                if (callback) {
                    callback(error);
                }
                if (error) {
                    return reject(error);
                }
                this._activeStream.sftp = true;
                this.registerNativeListener(NATIVE_EVENT_DOWNLOAD_PROGRESS);
                this.registerNativeListener(NATIVE_EVENT_UPLOAD_PROGRESS);
                resolve();
            });
        });
    }
    /**
     * Checks if SFTP is active. If not, it connects to SFTP.
     * @param callback - Optional callback function to handle errors.
     * @returns A promise that resolves when SFTP is active or rejects with an error.
     */
    checkSFTP(callback) {
        if (this._activeStream.sftp) {
            return Promise.resolve();
        }
        return this.connectSFTP()
            .catch((error) => {
            if (callback) {
                callback(error);
            }
            throw error;
        });
    }
    /**
     * Lists the files and directories in the specified path using SFTP.
     * @param path - The path to list.
     * @param callback - Optional callback function to handle the result asynchronously.
     * @returns A promise that resolves to the result of the SFTP listing operation.
     */
    sftpLs(path, callback) {
        return this.checkSFTP(callback)
            .then(() => new Promise((resolve, reject) => {
            RNSSHClient.sftpLs(path, this._key, (error, _response) => {
                const response = _response ? _response.map(p => {
                    // eslint-disable-next-line no-control-regex -- Control characters are removed from the response, because they can make JSON.parse fail
                    return JSON.parse(p.replace(/[\u0000-\u001F]/g, ''));
                }) : undefined;
                if (callback) {
                    callback(error, response);
                }
                if (error) {
                    return reject(error);
                }
                resolve(response);
            });
        }));
    }
    /**
     * Renames a file or directory on the remote server using SFTP.
     * @param oldPath The current path of the file or directory.
     * @param newPath The new path to rename the file or directory to.
     * @param callback An optional callback function to handle the result or error.
     * @returns A Promise that resolves when the file or directory is successfully renamed.
     */
    sftpRename(oldPath, newPath, callback) {
        return this.checkSFTP(callback)
            .then(() => new Promise((resolve, reject) => {
            RNSSHClient.sftpRename(oldPath, newPath, this._key, (error) => {
                if (callback) {
                    callback(error);
                }
                if (error) {
                    return reject(error);
                }
                resolve();
            });
        }));
    }
    /**
     * Creates a directory on the remote server using SFTP.
     * @param path - The path of the directory to create.
     * @param callback - An optional callback function to handle the result.
     * @returns A promise that resolves when the directory is created successfully.
     */
    sftpMkdir(path, callback) {
        return this.checkSFTP(callback)
            .then(() => new Promise((resolve, reject) => {
            RNSSHClient.sftpMkdir(path, this._key, (error) => {
                if (callback) {
                    callback(error);
                }
                if (error) {
                    return reject(error);
                }
                resolve();
            });
        }));
    }
    /**
     * Removes (unlinks) a file from the remote server using SFTP.
     * @param path - The path of the file to remove.
     * @param callback - An optional callback function to handle the result or error.
     * @returns A promise that resolves when the file is successfully removed.
     */
    sftpRm(path, callback) {
        return this.checkSFTP(callback)
            .then(() => new Promise((resolve, reject) => {
            RNSSHClient.sftpRm(path, this._key, (error) => {
                if (callback) {
                    callback(error);
                }
                if (error) {
                    return reject(error);
                }
                resolve();
            });
        }));
    }
    /**
     * Removes a directory on the remote server using SFTP.
     * @param path - The path of the directory to remove.
     * @param callback - Optional callback function to handle the result or error.
     * @returns A promise that resolves when the directory is successfully removed.
     */
    sftpRmdir(path, callback) {
        return this.checkSFTP(callback)
            .then(() => new Promise((resolve, reject) => {
            RNSSHClient.sftpRmdir(path, this._key, (error) => {
                if (callback) {
                    callback(error);
                }
                if (error) {
                    return reject(error);
                }
                resolve();
            });
        }));
    }
    /**
     * Changes the permissions of a file or directory on the remote server using SFTP.
     *
     * Only available on Android.
     * @param path - The path of the file or directory.
     * @param permissions - The new permissions to set.
     * @param callback - An optional callback function to handle the result or error.
     * @returns A Promise that resolves when the permissions are successfully changed.
     */
    sftpChmod(path, permissions, callback) {
        return this.checkSFTP(callback)
            .then(() => new Promise((resolve, reject) => {
            RNSSHClient.sftpChmod(path, permissions, this._key, (error) => {
                if (callback) {
                    callback(error);
                }
                if (error) {
                    return reject(error);
                }
                resolve();
            });
        }));
    }
    /**
     * Uploads a file from the local file system to the remote file system using SFTP.
     * @param localFilePath - The path of the file on the local file system.
     * @param remoteFilePath - The path of the file on the remote file system.
     * @param callback - An optional callback function to be called after the upload is complete or an error occurs.
     * @returns A Promise that resolves when the upload is complete or rejects with an error.
     */
    sftpUpload(localFilePath, remoteFilePath, callback) {
        // The native layer tracks a single cancel flag per client, so two concurrent
        // uploads on the same client would clobber each other's cancel state. Reject
        // a second upload while one is already running (review #13).
        if (this._counters.upload > 0) {
            const error = new Error('An SFTP upload is already in progress for this client');
            if (callback) {
                callback(error);
            }
            return Promise.reject(error);
        }
        return this.checkSFTP(callback)
            .then(() => new Promise((resolve, reject) => {
            ++this._counters.upload;
            RNSSHClient.sftpUpload(localFilePath, remoteFilePath, this._key, (error) => {
                --this._counters.upload;
                if (callback) {
                    callback(error);
                }
                if (error) {
                    return reject(error);
                }
                resolve();
            });
        }));
    }
    /**
     * Cancels the ongoing SFTP upload.
     */
    sftpCancelUpload() {
        if (this._counters.upload > 0) {
            RNSSHClient.sftpCancelUpload(this._key);
        }
    }
    /**
     * Downloads a file from the remote server using SFTP.
     * @param remoteFilePath - The path of the file on the remote server.
     * @param localFilePath - The path where the file will be saved locally.
     * @param callback - An optional callback function to handle the result of the download.
     * @returns A promise that resolves with the response string when the download is complete.
     */
    sftpDownload(remoteFilePath, localFilePath, callback) {
        // The native layer tracks a single cancel flag per client, so two concurrent
        // downloads on the same client would clobber each other's cancel state. Reject
        // a second download while one is already running (review #13).
        if (this._counters.download > 0) {
            const error = new Error('An SFTP download is already in progress for this client');
            if (callback) {
                callback(error);
            }
            return Promise.reject(error);
        }
        return this.checkSFTP(callback)
            .then(() => new Promise((resolve, reject) => {
            ++this._counters.download;
            RNSSHClient.sftpDownload(remoteFilePath, localFilePath, this._key, (error, response) => {
                --this._counters.download;
                if (callback) {
                    callback(error, response);
                }
                if (error) {
                    return reject(error);
                }
                resolve(response);
            });
        }));
    }
    /**
     * Cancels the ongoing SFTP download operation.
     */
    sftpCancelDownload() {
        if (this._counters.download > 0) {
            RNSSHClient.sftpCancelDownload(this._key);
        }
    }
    /**
     * Disconnects the SFTP connection, closing the SFTP channel and removing the
     * download/upload progress listeners. Supported on both iOS and Android.
     *
     * @example
     * ```typescript
     * disconnectSFTP();
     * ```
     */
    disconnectSFTP() {
        this.unregisterNativeListener(NATIVE_EVENT_DOWNLOAD_PROGRESS);
        this.unregisterNativeListener(NATIVE_EVENT_UPLOAD_PROGRESS);
        RNSSHClient.disconnectSFTP(this._key);
        this._activeStream.sftp = false;
    }
    /**
     * Disconnects the SSH client.
     * If a shell is active, it will be closed.
     * If an SFTP connection is active, it will be disconnected.
     * @returns void
     */
    disconnect() {
        this.off(NATIVE_EVENT_SHELL);
        this.off(NATIVE_EVENT_HERDR_EVENT_STREAM);
        this.off(NATIVE_EVENT_HERDR_COMMAND_STREAM);
        this._herdrBridgeHandlers.clear();
        this.unregisterNativeListener(NATIVE_EVENT_HERDR_BRIDGE);
        this.unregisterNativeListener(NATIVE_EVENT_HERDR_EVENT_STREAM);
        this.unregisterNativeListener(NATIVE_EVENT_HERDR_COMMAND_STREAM);
        this.unregisterNativeListener(NATIVE_EVENT_DOWNLOAD_PROGRESS);
        this.unregisterNativeListener(NATIVE_EVENT_UPLOAD_PROGRESS);
        this._activeStream.shell = false;
        this._activeStream.sftp = false;
        this._activeStream.herdrEventStream = false;
        this._activeStream.herdrCommandStream = false;
        RNSSHClient.disconnect(this._key);
    }
}
// Monotonic counter used, together with a timestamp, to build unique client keys.
SSHClient._keyCounter = 0;
export default SSHClient;
//# sourceMappingURL=sshclient.js.map
