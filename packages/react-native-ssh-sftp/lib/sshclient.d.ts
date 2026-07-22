/**
 * Represents the types of PTY (pseudo-terminal) for SSH connections.
 */
export declare enum PtyType {
    VANILLA = "vanilla",
    VT100 = "vt100",
    VT102 = "vt102",
    VT220 = "vt220",
    ANSI = "ansi",
    XTERM = "xterm"
}
type CBError = any;
/**
 * Represents a callback function with an optional response.
 * @template T The type of the response.
 * @param error The error object, if any.
 * @param response The response object, if any.
 */
export type CallbackFunction<T> = (error: CBError, response?: T) => void;
/**
 * Represents an event handler function.
 * @param value - The value passed to the event handler.
 */
export type EventHandler = (value: any) => void;
export interface HerdrBridgeEvent {
    type: 'terminal' | 'closed' | 'graphics' | 'notify' | 'clipboard' | 'title' | 'reload_sound_config' | 'mouse_capture' | 'prefix_input_source' | 'ignored';
    terminalId?: string;
    seq?: number;
    width?: number;
    height?: number;
    full?: boolean;
    bytes?: string;
    final?: boolean;
    text?: string;
    body?: string;
    flag?: boolean;
    kind?: number;
}
export interface HerdrCommandStreamEvent {
    data?: string;
    closed?: boolean;
    error?: string;
}
/**
 * Represents the result of a directory listing operation.
 */
export interface LsResult {
    filename: string;
    isDirectory: boolean;
    modificationDate: string;
    lastAccess: string;
    fileSize: number;
    ownerUserID: number;
    ownerGroupID: number;
    flags: number;
}
/**
 * Represents a key pair used for SSH authentication.
 */
export interface KeyPair {
    privateKey: string;
    publicKey?: string;
    passphrase?: string;
}
/**
 * Represents the result of a key pair generation operation.
 */
export interface GeneratedKeyPair {
    privateKey: string;
    publicKey?: string;
}
/**
 * Represents the details of an SSH key.
 */
export interface KeyDetails {
    keyType: string;
    keySize?: number;
    fingerprint: string;
    publicKey: string;
}
/**
 * @deprecated Use {@link GeneratedKeyPair} instead. This alias will be removed in a future major version.
 */
export type genKeyPair = GeneratedKeyPair;
/**
 * @deprecated Use {@link KeyDetails} instead. This alias will be removed in a future major version.
 */
export type keyDetail = KeyDetails;
/**
 * Represents a password or key for authentication.
 */
export type PasswordOrKey = string | KeyPair;
/**
 * Represents an SSH client that can connect to a remote server and perform various operations.
 * Instances of SSHClient are created using the following factory functions:
 * - SSHClient.connectWithKey()
 * - SSHClient.connectWithPassword()
 */
export default class SSHClient {
    /**
    * Retrieves the details of an SSH key.
    * @param key - The SSH private key as a string.
    * @param passphrase - The passphrase for an encrypted private key (optional).
    * @returns A Promise that resolves to the details of the key, including its fingerprint, type and size.
    */
    static getKeyDetails(key: string, passphrase?: string): Promise<KeyDetails>;
    static generateKeyPair(type: string, passphrase?: string, keySize?: number, comment?: string): Promise<GeneratedKeyPair>;
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
    static connectWithKey(host: string, port: number, username: string, privateKey: string, passphrase?: string, callback?: CallbackFunction<SSHClient>): Promise<SSHClient>;
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
    static connectWithPassword(host: string, port: number, username: string, password: string, callback?: CallbackFunction<SSHClient>): Promise<SSHClient>;
    private static _keyCounter;
    private _key;
    private _listeners;
    private _counters;
    private _activeStream;
    private _handlers;
    private host;
    private port;
    private username;
    /**
     * Creates a new SSHClient instance.
     * Should not be called directly; use the `connectWithKey` or `connectWithPassword` factory functions instead.
     * @param host The hostname or IP address of the SSH server.
     * @param port The port number of the SSH server.
     * @param username The username for authentication.
     * @param passwordOrKey The password or private key for authentication.
     * @param callback The callback function to be called after the connection is established.
     */
    constructor(host: string, port: number, username: string, passwordOrKey: PasswordOrKey, callback: CallbackFunction<void>);
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
    private static getRandomClientKey;
    /**
     * Handles a native event (callback).
     *
     * @param event The native event to handle.
     */
    private handleEvent;
    /**
     * Registers an event handler for the specified event.
     *
     * @param eventName - The name of the event.
     * @param handler - The event handler function.
     */
    on(eventName: string, handler: EventHandler): void;
    /**
     * Removes the handler registered for the specified event, if any.
     *
     * Handlers registered via {@link on} otherwise persist until replaced; use this
     * to cleanly tear down a subscription (for example in a component's unmount).
     *
     * @param eventName - The name of the event whose handler should be removed.
     */
    off(eventName: string): void;
    /**
     * Removes the handler registered for the specified event, if any.
     *
     * Alias for {@link off}, provided for familiarity with the event-emitter naming
     * convention.
     *
     * @param eventName - The name of the event whose handler should be removed.
     */
    removeListener(eventName: string): void;
    /**
     * Registers a native listener for the specified event name.
     *
     * @param eventName - The name of the event to listen for.
     */
    private registerNativeListener;
    /**
     * Unregisters a native listener for the specified event name.
     * @param eventName - The name of the event.
     */
    private unregisterNativeListener;
    /**
     * Connects to the SSH server using the provided password or key.
     *
     * @param passwordOrKey - The password or key to authenticate with the server.
     * @param callback - The callback function to be called after the connection attempt.
     */
    private connect;
    /**
     * Executes a command on the SSH server.
     * @param command The command to execute.
     * @param callback Optional callback function to handle the result asynchronously.
     * @returns A promise that resolves with the response from the server.
     */
    execute(command: string, callback?: CallbackFunction<string>): Promise<string>;
    /**
     * Starts a shell session on the SSH server.
     * @param ptyType - The type of pseudo-terminal to use for the shell session.
     * @param callback - Optional callback function to handle the response.
     * @returns A promise that resolves with the response from the server.
     */
    startShell(ptyType: PtyType, callback?: CallbackFunction<string>): Promise<string>;
    /**
     * Starts a shell that emits complete newline-delimited records atomically.
     * Android-only; other platforms fall back to startShell.
     */
    startLineShell(ptyType: PtyType, callback?: CallbackFunction<string>): Promise<string>;
    /**
     * Checks if the shell is active. If the shell is already active, it returns an empty string.
     * Otherwise, it starts a new shell and returns the result.
     * @param callback Optional callback function to handle errors.
     * @returns A promise that resolves to a string representing the result of the shell check.
     */
    private checkShell;
    /**
     * Writes a command to the shell.
     * @param command - The command to write to the shell.
     * @param callback - Optional callback function to handle the response.
     * @returns A promise that resolves with the response from the shell.
     */
    writeToShell(command: string, callback?: CallbackFunction<string>): Promise<string>;
    /** Resizes the active remote pseudo-terminal. */
    resizeShell(columns: number, rows: number): void;
    /**
     * Closes the SSH shell.
     */
    closeShell(): void;
    /** Starts Herdr's protocol-16 remote-client-bridge on a dedicated channel of this SSH session. */
    prepareHerdrBridge(command: string, protocol: number, columns: number, rows: number, cellWidthPx: number, cellHeightPx: number, callback?: CallbackFunction<void>): Promise<void>;
    startHerdrBridge(command: string, protocol: number, terminalId: string, takeover: boolean, columns: number, rows: number, cellWidthPx: number, cellHeightPx: number, handler: (event: HerdrBridgeEvent) => void, callback?: CallbackFunction<void>): Promise<void>;
    herdrBridgeInput(terminalId: string, text: string): Promise<void>;
    herdrBridgeResize(terminalId: string, columns: number, rows: number, cellWidthPx?: number, cellHeightPx?: number): Promise<void>;
    herdrBridgeScroll(terminalId: string, direction: 'up' | 'down', lines: number): Promise<void>;
    closeHerdrBridge(terminalId: string): void;
    closeAllHerdrBridges(): void;
    /** Opens a loopback listener that forwards through this SSH session. Android-only. */
    openLocalForward(remoteHost: string, remotePort: number): Promise<number>;
    /** Closes a loopback listener previously returned by openLocalForward. */
    closeLocalForward(localPort: number): Promise<void>;
    startHerdrEventStream(socketPath: string, handler: (data: string) => void, callback?: CallbackFunction<void>): Promise<void>;
    writeHerdrEventStream(value: string): Promise<void>;
    closeHerdrEventStream(): void;
    startHerdrCommandStream(command: string, handler: (event: HerdrCommandStreamEvent) => void, callback?: CallbackFunction<void>): Promise<void>;
    writeHerdrCommandStream(value: string): Promise<void>;
    closeHerdrCommandStream(): void;
    /**
     * Connects to the SFTP server.
     *
     * It is not mandatory to call this method before calling any SFTP method.
     * @param callback - Optional callback function to be called after the connection is established.
     * @returns A promise that resolves when the connection is established successfully, or rejects with an error if the connection fails.
     */
    connectSFTP(callback?: CallbackFunction<void>): Promise<void>;
    /**
     * Checks if SFTP is active. If not, it connects to SFTP.
     * @param callback - Optional callback function to handle errors.
     * @returns A promise that resolves when SFTP is active or rejects with an error.
     */
    private checkSFTP;
    /**
     * Lists the files and directories in the specified path using SFTP.
     * @param path - The path to list.
     * @param callback - Optional callback function to handle the result asynchronously.
     * @returns A promise that resolves to the result of the SFTP listing operation.
     */
    sftpLs(path: string, callback?: CallbackFunction<LsResult[]>): Promise<LsResult[]>;
    /**
     * Renames a file or directory on the remote server using SFTP.
     * @param oldPath The current path of the file or directory.
     * @param newPath The new path to rename the file or directory to.
     * @param callback An optional callback function to handle the result or error.
     * @returns A Promise that resolves when the file or directory is successfully renamed.
     */
    sftpRename(oldPath: string, newPath: string, callback?: CallbackFunction<void>): Promise<void>;
    /**
     * Creates a directory on the remote server using SFTP.
     * @param path - The path of the directory to create.
     * @param callback - An optional callback function to handle the result.
     * @returns A promise that resolves when the directory is created successfully.
     */
    sftpMkdir(path: string, callback?: CallbackFunction<void>): Promise<void>;
    /**
     * Removes (unlinks) a file from the remote server using SFTP.
     * @param path - The path of the file to remove.
     * @param callback - An optional callback function to handle the result or error.
     * @returns A promise that resolves when the file is successfully removed.
     */
    sftpRm(path: string, callback?: CallbackFunction<void>): Promise<void>;
    /**
     * Removes a directory on the remote server using SFTP.
     * @param path - The path of the directory to remove.
     * @param callback - Optional callback function to handle the result or error.
     * @returns A promise that resolves when the directory is successfully removed.
     */
    sftpRmdir(path: string, callback?: CallbackFunction<void>): Promise<void>;
    /**
     * Changes the permissions of a file or directory on the remote server using SFTP.
     *
     * Only available on Android.
     * @param path - The path of the file or directory.
     * @param permissions - The new permissions to set.
     * @param callback - An optional callback function to handle the result or error.
     * @returns A Promise that resolves when the permissions are successfully changed.
     */
    sftpChmod(path: string, permissions: number, callback?: CallbackFunction<void>): Promise<void>;
    /**
     * Uploads a file from the local file system to the remote file system using SFTP.
     * @param localFilePath - The path of the file on the local file system.
     * @param remoteFilePath - The path of the file on the remote file system.
     * @param callback - An optional callback function to be called after the upload is complete or an error occurs.
     * @returns A Promise that resolves when the upload is complete or rejects with an error.
     */
    sftpUpload(localFilePath: string, remoteFilePath: string, callback?: CallbackFunction<void>): Promise<void>;
    /**
     * Cancels the ongoing SFTP upload.
     */
    sftpCancelUpload(): void;
    /**
     * Downloads a file from the remote server using SFTP.
     * @param remoteFilePath - The path of the file on the remote server.
     * @param localFilePath - The path where the file will be saved locally.
     * @param callback - An optional callback function to handle the result of the download.
     * @returns A promise that resolves with the response string when the download is complete.
     */
    sftpDownload(remoteFilePath: string, localFilePath: string, callback?: CallbackFunction<string>): Promise<string>;
    /**
     * Cancels the ongoing SFTP download operation.
     */
    sftpCancelDownload(): void;
    /**
     * Disconnects the SFTP connection, closing the SFTP channel and removing the
     * download/upload progress listeners. Supported on both iOS and Android.
     *
     * @example
     * ```typescript
     * disconnectSFTP();
     * ```
     */
    disconnectSFTP(): void;
    /**
     * Disconnects the SSH client.
     * If a shell is active, it will be closed.
     * If an SFTP connection is active, it will be disconnected.
     * @returns void
     */
    disconnect(): void;
}
export {};
//# sourceMappingURL=sshclient.d.ts.map
