const COOKIE_NAME = 'cet_visitor';
const encoder = new TextEncoder();

function base64urlEncode(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64urlDecode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid_encoding');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function cookieHeader(request) {
  const headers = request?.headers;
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get('cookie') || '';
  if (Array.isArray(headers)) {
    return headers.flatMap(header => Array.isArray(header) ? header : [header])
      .filter(header => Array.isArray(header) && String(header[0]).toLowerCase() === 'cookie')
      .map(header => String(header[1])).join('; ');
  }
  if (typeof headers === 'object') {
    return Object.entries(headers).filter(([name]) => name.toLowerCase() === 'cookie')
      .map(([, value]) => String(value)).join('; ');
  }
  return '';
}

export function createVisitorTickets({ secret, ttlMs = 86400000, secureCookies = true } = {}) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('visitor_secret_must_be_at_least_32_characters');
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error('visitor_ttl_invalid');

  async function sign(payload) {
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    return base64urlEncode(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload))));
  }

  async function issue(visitorId, ipHash) {
    if (typeof visitorId !== 'string' || !visitorId.trim() || visitorId.length > 256 || /[\r\n]/.test(visitorId)) {
      throw new Error('visitor_id_invalid');
    }
    if (typeof ipHash !== 'string' || !ipHash.trim() || ipHash.length > 256 || /[\r\n]/.test(ipHash)) {
      throw new Error('ip_hash_invalid');
    }
    const payload = base64urlEncode(encoder.encode(JSON.stringify({
      v: 1,
      id: visitorId,
      exp: Date.now() + ttlMs,
      ipHash,
    })));
    return `${payload}.${await sign(payload)}`;
  }

  async function verify(token) {
    if (typeof token !== 'string' || token.length > 4096) return null;
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    try {
      const expected = await sign(parts[0]);
      const actualBytes = base64urlDecode(parts[1]);
      const expectedBytes = base64urlDecode(expected);
      if (!constantTimeEqual(actualBytes, expectedBytes)) return null;
      const parsed = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[0])));
      if (!parsed || parsed.v !== 1 || typeof parsed.id !== 'string' || !parsed.id
        || !Number.isSafeInteger(parsed.exp) || typeof parsed.ipHash !== 'string' || !parsed.ipHash
        || parsed.id.length > 256 || parsed.ipHash.length > 256 || parsed.exp <= Date.now()) {
        return null;
      }
      return { v: 1, id: parsed.id, exp: parsed.exp, ipHash: parsed.ipHash };
    } catch {
      return null;
    }
  }

  function readCookie(request) {
    for (const part of cookieHeader(request).split(';')) {
      const separator = part.indexOf('=');
      if (separator < 0 || part.slice(0, separator).trim() !== COOKIE_NAME) continue;
      const value = part.slice(separator + 1).trim();
      return value && !/[\r\n]/.test(value) ? value : null;
    }
    return null;
  }

  function setCookie(_request, token) {
    if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw new Error('visitor_token_invalid');
    // The caller copies this returned value into its Response Set-Cookie header.
    return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/${secureCookies ? '; Secure' : ''}`;
  }

  return { issue, verify, readCookie, setCookie };
}
