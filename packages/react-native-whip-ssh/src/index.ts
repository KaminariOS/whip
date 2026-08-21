import { pairHost as pairHostRust } from './generated-entry';

type PairingResponse = {
  ok: boolean;
  value?: unknown;
  error?: string;
};

const nativeClient = {
  async pairHost(code: string, publicKey: string, deviceName: string): Promise<unknown> {
    const response = JSON.parse(await pairHostRust(code, publicKey, deviceName)) as PairingResponse;
    if (!response.ok) throw new Error(response.error || 'WP4 pairing failed');
    return response.value;
  },
};

export default nativeClient;
