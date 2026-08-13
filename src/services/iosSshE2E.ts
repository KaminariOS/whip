import SSHClient, { PtyType } from '@dylankenneally/react-native-ssh-sftp';
import { Directory, File, Paths } from 'expo-file-system';

export const IOS_SSH_E2E_CONFIG_FILE = 'whip-ios-ssh-e2e-config.json';
export const IOS_SSH_E2E_RESULT_FILE = 'whip-ios-ssh-e2e-result.json';

interface IosSshE2EConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  privateKey: string;
  knownHostLine: string;
  changedHostLine: string;
}

interface IosSshE2EStep {
  name: string;
  durationMs: number;
}

export interface IosSshE2EResult {
  status: 'passed' | 'failed';
  steps: IosSshE2EStep[];
  error?: string;
  durationMs: number;
}

export async function runIosSshE2E(
  onStep: (name: string) => void = () => undefined,
): Promise<IosSshE2EResult> {
  const startedAt = Date.now();
  const steps: IosSshE2EStep[] = [];
  const clients: SSHClient[] = [];
  const resources: {
    cleanupClient?: SSHClient;
    localForward?: { client: SSHClient; port: number };
  } = {};
  let remoteDirectory: string | null = null;
  let result: IosSshE2EResult;

  const step = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    onStep(name);
    console.log(`[WHIP_IOS_SSH_E2E] START ${name}`);
    const stepStartedAt = Date.now();
    const value = await withTimeout(action(), 30_000, name);
    const durationMs = Date.now() - stepStartedAt;
    steps.push({ name, durationMs });
    console.log(`[WHIP_IOS_SSH_E2E] PASS ${name} (${durationMs}ms)`);
    return value;
  };

  try {
    const config = await step('load simulator configuration', loadConfig);

    await step('reject unknown host key', async () => {
      SSHClient.setKnownHosts('');
      await expectConnectionFailure(
        () => SSHClient.connectWithKey(
          config.host,
          config.port,
          config.username,
          config.privateKey,
        ),
        'E_HOST_KEY_UNKNOWN:',
      );
    });

    await step('reject changed host key', async () => {
      SSHClient.setKnownHosts(config.changedHostLine);
      await expectConnectionFailure(
        () => SSHClient.connectWithKey(
          config.host,
          config.port,
          config.username,
          config.privateKey,
        ),
        'E_HOST_KEY_CHANGED:',
      );
    });

    SSHClient.setKnownHosts(config.knownHostLine);
    const passwordClient = await step('authenticate with password', async () => {
      const client = await SSHClient.connectWithPassword(
        config.host,
        config.port,
        config.username,
        config.password,
      );
      clients.push(client);
      assertIncludes(await client.execute('printf whip-password-auth'), 'whip-password-auth');
      return client;
    });
    passwordClient.disconnect();

    const keyClient = await step('authenticate with Ed25519 key', async () => {
      const details = await SSHClient.getKeyDetails(config.privateKey);
      if (details.keyType !== 'ssh-ed25519') {
        throw new Error(`Expected ssh-ed25519 key, received ${details.keyType}`);
      }
      const client = await SSHClient.connectWithKey(
        config.host,
        config.port,
        config.username,
        config.privateKey,
      );
      clients.push(client);
      resources.cleanupClient = client;
      return client;
    });

    await step('execute command', async () => {
      assertIncludes(await keyClient.execute('printf whip-execute'), 'whip-execute');
    });

    await step('open interactive PTY shell', async () => {
      await keyClient.startShell(PtyType.XTERM);
      const shellOutput = waitForShellToken(keyClient, 'whip-shell-ready');
      await keyClient.writeToShell("printf 'whip-shell-ready\\n'\n");
      await shellOutput;
      keyClient.closeShell();
    });

    await step('forward authenticated SSH agent', async () => {
      keyClient.setAgentForwarding(true);
      assertIncludes(await keyClient.execute('ssh-add -L'), 'ssh-ed25519');
    });

    await step('upload and download with SFTP', async () => {
      const remoteHome = (await keyClient.getRemoteHome()).trim();
      remoteDirectory = `${remoteHome}/.whip-ios-e2e-${Date.now()}`;
      await keyClient.execute(`mkdir -p '${remoteDirectory}'`);
      await keyClient.connectSFTP();

      const localDirectory = new Directory(Paths.cache, `whip-ios-e2e-${Date.now()}`);
      localDirectory.create({ idempotent: true });
      const upload = new File(localDirectory, 'payload.txt');
      upload.write('whip-sftp-payload');
      await keyClient.sftpUpload(nativePath(upload.uri), remoteDirectory);

      const listing = await keyClient.sftpLs(remoteDirectory);
      if (!listing.some(entry => entry.filename === 'payload.txt')) {
        throw new Error('Uploaded SFTP file was not present in directory listing');
      }

      const downloadDirectory = new Directory(localDirectory, 'download');
      downloadDirectory.create({ idempotent: true });
      const downloadedPath = await keyClient.sftpDownload(
        `${remoteDirectory}/payload.txt`,
        `${nativePath(downloadDirectory.uri)}/`,
      );
      const downloaded = new File(fileUri(downloadedPath));
      if (await downloaded.text() !== 'whip-sftp-payload') {
        throw new Error('Downloaded SFTP content did not match the uploaded file');
      }
      localDirectory.delete();
    });

    await step('connect through ProxyJump chain', async () => {
      const jumped = await SSHClient.connectWithKeyViaJump(
        config.host,
        config.port,
        config.username,
        config.privateKey,
        undefined,
        keyClient,
      );
      clients.push(jumped);
      assertIncludes(await jumped.execute('printf whip-jump'), 'whip-jump');
    });

    await step('connect through local TCP forwarding', async () => {
      const localPort = await keyClient.openLocalForward(config.host, config.port);
      resources.localForward = { client: keyClient, port: localPort };
      SSHClient.setKnownHosts([
        config.knownHostLine,
        knownHostLineForPort(config.knownHostLine, config.host, localPort),
      ].join('\n'));
      const forwarded = await SSHClient.connectWithKey(
        '127.0.0.1',
        localPort,
        config.username,
        config.privateKey,
      );
      clients.push(forwarded);
      assertIncludes(await forwarded.execute('printf whip-local-forward'), 'whip-local-forward');
    });

    result = {
      status: 'passed',
      steps,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    result = {
      status: 'failed',
      steps,
      error: errorMessage(error),
      durationMs: Date.now() - startedAt,
    };
    console.error(`[WHIP_IOS_SSH_E2E] FAIL ${result.error}`);
  } finally {
    if (resources.localForward) {
      await withTimeout(
        resources.localForward.client.closeLocalForward(resources.localForward.port),
        5_000,
        'local forwarding cleanup',
      )
        .catch(() => undefined);
    }
    if (resources.cleanupClient && remoteDirectory) {
      await withTimeout(
        resources.cleanupClient.execute(`rm -rf '${remoteDirectory}'`),
        5_000,
        'remote SFTP cleanup',
      ).catch(() => undefined);
    }
    for (const client of clients.reverse()) client.disconnect();
  }
  writeResult(result);
  return result;
}

async function loadConfig(): Promise<IosSshE2EConfig> {
  const file = new File(Paths.document, IOS_SSH_E2E_CONFIG_FILE);
  if (!file.exists) throw new Error(`Missing ${IOS_SSH_E2E_CONFIG_FILE}`);
  const parsed = JSON.parse(await file.text()) as Partial<IosSshE2EConfig>;
  for (const key of ['host', 'username', 'password', 'privateKey', 'knownHostLine', 'changedHostLine'] as const) {
    if (typeof parsed[key] !== 'string' || parsed[key].length === 0) {
      throw new Error(`Invalid iOS SSH E2E configuration field: ${key}`);
    }
  }
  if (!Number.isInteger(parsed.port) || Number(parsed.port) <= 0) {
    throw new Error('Invalid iOS SSH E2E configuration field: port');
  }
  return parsed as IosSshE2EConfig;
}

async function expectConnectionFailure(connect: () => Promise<SSHClient>, expected: string): Promise<void> {
  let client: SSHClient;
  try {
    client = await connect();
  } catch (error) {
    if (errorMessage(error).includes(expected)) return;
    throw error;
  }
  client.disconnect();
  throw new Error(`Connection unexpectedly succeeded; expected ${expected}`);
}

function waitForShellToken(client: SSHClient, token: string): Promise<void> {
  return withTimeout(new Promise(resolve => {
    client.on('Shell', value => {
      if (String(value).includes(token)) {
        client.off('Shell');
        resolve();
      }
    });
  }), 10_000, 'interactive shell output');
}

function knownHostLineForPort(line: string, host: string, port: number): string {
  const fields = line.trim().split(/\s+/);
  if (fields.length < 3) throw new Error('Invalid trusted known_hosts line');
  return `[${host}]:${port} ${fields[1]} ${fields[2]}`;
}

function assertIncludes(value: string, expected: string): void {
  if (!value.includes(expected)) throw new Error(`Expected output to contain ${expected}: ${value}`);
}

function nativePath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}

function fileUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeResult(result: IosSshE2EResult): void {
  const serialized = JSON.stringify(result, null, 2);
  new File(Paths.document, IOS_SSH_E2E_RESULT_FILE).write(serialized);
  console.log(`[WHIP_IOS_SSH_E2E] RESULT ${JSON.stringify(result)}`);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
