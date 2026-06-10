// Safety primitives for modulus-websearch.
//
// The whole point of this extension is to pull *untrusted* text off the open
// web and hand it to an LLM. Two classes of risk follow from that, and this
// file owns the defenses for both:
//
//   1. SSRF — a search result (or a user-supplied SearXNG URL) could point at
//      a private/loopback/link-local address or the cloud metadata endpoint.
//      `isSafeUrl` refuses anything that isn't a public http(s) host.
//   2. Injection / markup — fetched HTML is stripped to plain text before it
//      ever reaches a prompt, and the caller wraps it as DATA-not-instructions.
//
// Both are conservative on purpose: when in doubt, reject.

// Reject anything that isn't a plain public http(s) URL. Blocks loopback,
// private, link-local, CGNAT, and the well-known cloud metadata IP, plus
// embedded credentials and non-web schemes.
export function isSafeUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false; // user:pass@ — credential smuggling

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return false;

  if (isIpv4(host)) return !isPrivateIpv4(host);
  if (host.includes(':')) return !isPrivateIpv6(host); // bracket-stripped IPv6 literal
  return true; // a normal DNS name — allowed (we can't resolve here; the fetch's
  // redirect handling and the per-host scheme check above are the guard rails)
}

function isIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // this-net, private, loopback
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === '::1' || h === '::') return true; // loopback / unspecified
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb'))
    return true; // link-local fe80::/10
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // unique-local fc00::/7
  if (h.startsWith('::ffff:')) return true; // IPv4-mapped — treat as private to be safe
  return false;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&nbsp;': ' ',
  '&hellip;': '…',
  '&mdash;': '—',
  '&ndash;': '–',
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCharCode(Number.parseInt(h, 16)))
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}

// Strip HTML to readable plain text. Drops script/style/noscript wholesale,
// turns block tags into newlines, removes the rest, decodes entities, and
// collapses whitespace. Defensive against unclosed tags.
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, ' ')
      // Block-level tags become line breaks (so words across blocks don't jam
      // together); everything else (inline tags like <b>, <a>) is removed with
      // no inserted space, so "moon</b>'s" stays "moon's".
      .replace(
        /<\/?(?:p|div|section|article|li|ul|ol|h[1-6]|tr|table|blockquote|header|footer|main|nav)[^>]*>/gi,
        '\n',
      )
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '');
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

// Neutralize the delimiter tokens that wrapUntrusted relies on, so a search
// result can't forge an end-marker and "break out" of the untrusted data block
// to inject trailing instructions that look like they're outside the data.
export function neutralizeMarkers(text: string): string {
  return text
    .replace(/WEB_RESULTS/gi, 'WEB-RESULTS')
    .replace(/<{3,}/g, '«')
    .replace(/>{3,}/g, '»');
}

// Pull a clean hostname for display ("example.com"); empty string if unparseable.
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
