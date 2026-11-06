// neonauth.mjs — verification of Neon Auth (managed Better Auth) JWTs.
//
// The app's own console sessions are the primary identity (server.mjs). This module
// adds the Neon Auth service on top: any caller holding a valid JWT minted by the
// tenant at NEON_AUTH_BASE_URL can be authenticated here, verified against the
// tenant's JWKS at NEON_AUTH_JWKS_URL. Verification is pure WebCrypto in the server
// process — ES256 (P-256), EdDSA (Ed25519) and RS256 keys are accepted, since Better
// Auth's JWT plugin emits any of the three.
//
// Trust rules enforced, in order:
//   • the signature is verified against the JWKS key with the matching `kid`
//     (falling back to a lone key) — nothing else is trusted;
//   • `exp` must be in the future, `nbf` in the past;
//   • `iss` must belong to the Neon Auth tenant's origin.

const JWKS_CACHE_MS = 15 * 60_000;

const dec64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function importJwk(k) {
  switch (k.kty) {
    case 'EC':
      return crypto.subtle.importKey('jwk', k, { name: 'ECDSA', namedCurve: k.crv || 'P-256' }, false, ['verify']);
    case 'OKP':
      return crypto.subtle.importKey('jwk', k, { name: k.crv || 'Ed25519' }, false, ['verify']);
    case 'RSA':
      return crypto.subtle.importKey('jwk', k, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    default:
      throw new Error(`unsupported key type ${k.kty}`);
  }
}

async function verifyWith(key, alg, signature, data) {
  if (alg === 'ES256') {
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, data);
  }
  if (alg === 'EdDSA' || alg === 'Ed25519') {
    return crypto.subtle.verify({ name: 'Ed25519' }, key, signature, data);
  }
  if (alg === 'RS256') {
    return crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, key, signature, data);
  }
  throw new Error(`unsupported algorithm ${alg}`);
}

export class NeonAuth {
  constructor({ jwksUrl, baseUrl, fetch: doFetch = fetch, now = () => new Date() } = {}) {
    this.jwksUrl = String(jwksUrl || '');
    this.baseUrl = String(baseUrl || '');
    this.doFetch = doFetch;
    this.now = now;
    this.jwksCache = null; // { keys, at }
  }

  /** The tenant's public keys, cached for 15 minutes. This is the live wire to Neon Auth. */
  async jwks(force = false) {
    if (!this.jwksUrl) throw new Error('NEON_AUTH_JWKS_URL is not configured');
    const c = this.jwksCache;
    if (!force && c && this.now().getTime() - c.at < JWKS_CACHE_MS) return c.keys;
    const res = await this.doFetch(this.jwksUrl, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
    const jwks = await res.json();
    if (!Array.isArray(jwks?.keys) || !jwks.keys.length) throw new Error('JWKS has no keys');
    this.jwksCache = { keys: jwks.keys, at: this.now().getTime() };
    return jwks.keys;
  }

  #candidatesOf(header, keys) {
    if (header.kid) return keys.filter((k) => k.kid === header.kid);
    return keys.length === 1 ? keys : [];
  }

  /** Verify one JWT. Returns { ok, claims, header } or { ok: false, error }. */
  async verify(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return { ok: false, error: 'not a three-part JWT' };
    let header;
    let claims;
    try {
      header = JSON.parse(dec64u(parts[0]));
      claims = JSON.parse(dec64u(parts[1]));
    } catch {
      return { ok: false, error: 'malformed JWT envelope' };
    }
    const t = this.now().getTime();
    if (typeof claims.exp === 'number' && t >= claims.exp * 1000) return { ok: false, error: 'token expired' };
    if (typeof claims.nbf === 'number' && t < claims.nbf * 1000) return { ok: false, error: 'token not yet valid' };
    if (this.baseUrl && claims.iss && !String(claims.iss).startsWith(new URL(this.baseUrl).origin)) {
      return { ok: false, error: `issuer ${claims.iss} is not this Neon Auth tenant` };
    }
    let keys;
    try {
      keys = await this.jwks();
    } catch (e) {
      return { ok: false, error: `JWKS unavailable: ${e.message}` };
    }
    const candidates = this.#candidatesOf(header, keys);
    if (!candidates.length) {
      return { ok: false, error: header.kid ? `no JWKS key matches kid ${header.kid}` : 'the token names no kid and the JWKS has multiple keys' };
    }
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    for (const k of candidates) {
      try {
        const key = await importJwk(k);
        if (await verifyWith(key, header.alg, dec64u(parts[2]), signed)) {
          return { ok: true, claims, header, keyId: k.kid };
        }
      } catch { /* try the next candidate key */ }
    }
    return { ok: false, error: 'signature verification failed' };
  }
}
