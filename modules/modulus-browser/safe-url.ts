import { lookup } from 'node:dns/promises';

export async function isSafeUrl(
  raw: string,
): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'protocol must be http: or https:' };
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    return { ok: false, reason: 'hostname is empty' };
  }
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.internal')
  ) {
    return { ok: false, reason: 'hostname is forbidden' };
  }

  let address: string;
  let family: number;
  try {
    const res = await lookup(hostname);
    address = res.address;
    family = res.family;
  } catch {
    return { ok: false, reason: 'DNS resolution failed' };
  }

  if (family === 4) {
    if (isPrivateIpv4(parseIpv4(address))) {
      return { ok: false, reason: 'resolves to a private IPv4 address' };
    }
  } else if (family === 6) {
    if (isPrivateIpv6(address)) {
      return { ok: false, reason: 'resolves to a private IPv6 address' };
    }
  }

  return { ok: true, url: parsed.toString() };
}

function isIpV4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d+$/.test(p) && parseInt(p, 10) >= 0 && parseInt(p, 10) <= 255);
}

function parseIpv4(host: string): number[] {
  return host.split('.').map((p) => parseInt(p, 10));
}

function isPrivateIpv4(parts: number[]): boolean {
  // Defaults satisfy noUncheckedIndexedAccess; -1 matches no real octet range.
  const [a = -1, b = -1, c = -1] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10
  if (a === 127) return true; // 127/8
  if (a === 169 && b === 254) return true; // 169.254/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2/24
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 198 && b >= 18 && b <= 19) return true; // 198.18/15
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100/24
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113/24
  if (a >= 224 && a <= 239) return true; // 224/4
  if (a >= 240 && a <= 255) return true; // 240/4 (encompasses 255.255.255.255)
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === '::1' || h === '::') return true;

  // IPv4-mapped (::ffff:a.b.c.d). Node normalises the dotted suffix to hex
  // (::ffff:7f00:1), so handle both: a dotted suffix is parsed as IPv4, a
  // two-hextet suffix is reassembled into four octets, then re-checked.
  const mapped = /^::ffff:(.+)$/.exec(h);
  if (mapped) {
    const suffix = mapped[1] ?? '';
    if (suffix.includes('.')) {
      if (isIpV4(suffix)) return isPrivateIpv4(parseIpv4(suffix));
    } else {
      const words = suffix.split(':');
      if (words.length === 2) {
        const hi = parseInt(words[0] ?? '', 16);
        const lo = parseInt(words[1] ?? '', 16);
        if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
          return isPrivateIpv4([(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff]);
        }
      }
    }
  }

  // unique-local fc00::/7 and link-local fe80::/10
  const first = /^([0-9a-f]{1,4}):/.exec(h);
  if (first) {
    const firstWord = parseInt(first[1] ?? '', 16);
    if ((firstWord & 0xfe00) === 0xfc00) return true;
    if ((firstWord & 0xffc0) === 0xfe80) return true;
  }

  return false;
}
