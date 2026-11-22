import { lookup } from 'node:dns/promises';
import { isIP, isIPv4, isIPv6 } from 'node:net';

export class SsrfError extends Error {
  readonly code: 'INVALID_URL' | 'DISALLOWED_PROTOCOL' | 'DISALLOWED_ADDRESS' | 'DNS_FAILED';

  constructor(
    code: 'INVALID_URL' | 'DISALLOWED_PROTOCOL' | 'DISALLOWED_ADDRESS' | 'DNS_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'SsrfError';
    this.code = code;
  }
}

export function stripHostBrackets(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
}

export function isLoopbackHost(hostname: string): boolean {
  const host = stripHostBrackets(hostname);
  return (
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
  );
}

function parseIpv4Octets(address: string): [number, number, number, number] | null {
  const clean = stripHostBrackets(address);
  if (!isIPv4(clean)) return null;
  const parts = clean.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return [parts[0], parts[1], parts[2], parts[3]];
}

export function classifyIpv4(address: string): 'public' | 'private' | 'never' {
  const octets = parseIpv4Octets(address);
  if (!octets) return 'never';
  const [a, b, c] = octets;

  // Never-routable: unspecified, loopback, link-local / cloud metadata, multicast/reserved, benchmarking/doc nets
  if (
    a === 0 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    a >= 224 ||
    (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  ) {
    return 'never';
  }

  // Private / CGNAT / Tailscale mesh
  if (
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  ) {
    return 'private';
  }

  return 'public';
}

export function isPublicIpv4Address(address: string): boolean {
  return classifyIpv4(address) === 'public';
}

function parseIpv6Words(address: string): number[] | null {
  const clean = stripHostBrackets(address);
  if (clean.includes('%') || !isIPv6(clean)) return null;

  let working = clean;
  const lastColon = working.lastIndexOf(':');
  const tail = working.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4Octets(tail);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    working = `${working.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const sides = working.split('::');
  if (sides.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const tokens = side.split(':');
    const out: number[] = [];
    for (const token of tokens) {
      if (!/^[0-9a-f]{1,4}$/i.test(token)) return null;
      out.push(Number.parseInt(token, 16));
    }
    return out;
  };

  const left = parseSide(sides[0]);
  if (!left) return null;

  if (sides.length === 1) {
    return left.length === 8 ? left : null;
  }

  const right = parseSide(sides[1]);
  if (!right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array<number>(missing).fill(0), ...right];
}

export function classifyIpv6(address: string): 'public' | 'private' | 'never' {
  const words = parseIpv6Words(address);
  if (!words) return 'never';

  const allZeroExceptLast = words.slice(0, 7).every((w) => w === 0);
  if (allZeroExceptLast && (words[7] === 0 || words[7] === 1)) {
    return 'never'; // :: or ::1
  }

  // IPv4-mapped ::ffff:0:0/96
  if (
    words[0] === 0 &&
    words[1] === 0 &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0xffff
  ) {
    const a = (words[6] >> 8) & 0xff;
    const b = words[6] & 0xff;
    const c = (words[7] >> 8) & 0xff;
    const d = words[7] & 0xff;
    return classifyIpv4(`${a}.${b}.${c}.${d}`);
  }

  // Unique local fc00::/7
  if ((words[0] & 0xfe00) === 0xfc00) {
    return 'private';
  }

  // Link-local fe80::/10 or multicast ff00::/8
  if ((words[0] & 0xffc0) === 0xfe80 || (words[0] & 0xff00) === 0xff00) {
    return 'never';
  }

  // NAT64: 64:ff9b::/96 or 64:ff9b:1::/48
  if (words[0] === 0x0064 && words[1] === 0xff9b) {
    if (words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0) return 'private';
    if (words[2] === 1) return 'private';
  }

  // Discard 100::/64 or documentation 2001:db8::/32
  if (
    (words[0] === 0x0100 && words[1] === 0 && words[2] === 0 && words[3] === 0) ||
    (words[0] === 0x2001 && words[1] === 0x0db8)
  ) {
    return 'never';
  }

  return 'public';
}

export function isPublicIpv6Address(address: string): boolean {
  return classifyIpv6(address) === 'public';
}

export function classifyIp(address: string): 'public' | 'private' | 'never' {
  const clean = stripHostBrackets(address);
  const version = isIP(clean);
  if (version === 4) return classifyIpv4(clean);
  if (version === 6) return classifyIpv6(clean);
  return 'never';
}

export interface AssertPublicUrlOptions {
  readonly allowlistHosts?: readonly string[];
  readonly resolveHost?: (hostname: string) => Promise<string[]>;
}

export async function assertPublicUrl(
  rawUrl: string,
  options: AssertPublicUrlOptions = {},
): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError('INVALID_URL', `Invalid URL: ${rawUrl}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError('DISALLOWED_PROTOCOL', `Blocked protocol "${url.protocol}" on ${rawUrl}`);
  }

  const host = stripHostBrackets(url.hostname);
  if (!host) {
    throw new SsrfError('INVALID_URL', `Missing hostname on ${rawUrl}`);
  }

  const allowlist = new Set((options.allowlistHosts ?? []).map((h) => stripHostBrackets(h)));
  if (allowlist.has(host)) {
    return { url, addresses: [] };
  }

  if (isLoopbackHost(host)) {
    throw new SsrfError('DISALLOWED_ADDRESS', `Blocked loopback host "${host}"`);
  }

  if (isIP(host) !== 0) {
    const ipClass = classifyIp(host);
    if (ipClass !== 'public') {
      throw new SsrfError('DISALLOWED_ADDRESS', `Blocked ${ipClass} IP address "${host}"`);
    }
    return { url, addresses: [host] };
  }

  const resolveHost =
    options.resolveHost ??
    (async (hostname: string) => {
      const records = await lookup(hostname, { all: true });
      return records.map((record) => record.address);
    });

  let addresses: string[];
  try {
    addresses = await resolveHost(host);
  } catch (error) {
    throw new SsrfError(
      'DNS_FAILED',
      `Failed to resolve "${host}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (addresses.length === 0) {
    throw new SsrfError('DNS_FAILED', `No DNS records returned for "${host}"`);
  }

  for (const address of addresses) {
    const ipClass = classifyIp(address);
    if (ipClass !== 'public') {
      throw new SsrfError(
        'DISALLOWED_ADDRESS',
        `Blocked resolved ${ipClass} IP "${address}" for "${host}"`,
      );
    }
  }

  return { url, addresses };
}
