export interface TerminalWebLinkTarget {
  url: string;
  hostname: string;
  port: number;
  requiresSshTunnel: boolean;
}

function ipv4Octets(hostname: string): number[] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map(part => Number(part));
  return octets.every((octet, index) => (
    Number.isInteger(octet)
      && octet >= 0
      && octet <= 255
      && String(octet) === parts[index]
  )) ? octets : null;
}

export function isSshTunnelHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::' || host === '::1') {
    return true;
  }
  if (/^(?:fc|fd)[0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) {
    return true;
  }

  const octets = ipv4Octets(host);
  if (!octets) return false;
  const [first, second] = octets;
  return first === 0
    || first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

export function terminalWebLinkTarget(value: string): TerminalWebLinkTarget {
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS links can be opened');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Web link port must be between 1 and 65535');
  }
  return {
    url: parsed.toString(),
    hostname: hostname === '0.0.0.0' ? '127.0.0.1' : hostname === '::' ? '::1' : hostname,
    port,
    requiresSshTunnel: isSshTunnelHost(hostname),
  };
}

export function localTunnelUrl(value: string, localPort: number): string {
  const parsed = new URL(value);
  const credentials = parsed.username
    ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@`
    : '';
  const localHostname = parsed.hostname === 'localhost' ? 'localhost' : '127.0.0.1';
  return `${parsed.protocol}//${credentials}${localHostname}:${localPort}${parsed.pathname}${parsed.search}${parsed.hash}`;
}
