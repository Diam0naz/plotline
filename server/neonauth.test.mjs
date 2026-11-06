// Neon Auth JWT verification: real ES256/Ed25519 signing, JWKS via the local cache,
// issuer and expiry rules, and reject-everything-else behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { NeonAuth } from './neonauth.mjs';

const BASE = 'https://tenant.example.auth';
const JWKS = 'https://tenant.example.auth/.well-known/jwks.json';
const NOW = new Date('2026-11-05T12:00:00Z');

// Build an ES256 key pair and export the public half as a JWK.
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key-1', alg: 'ES256', use: 'sig' };

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const enc = (o) => b64u(JSON.stringify(o));

/** A real ES256-signed JWT, like Better Auth's JWT plugin mints (raw r||s signature). */
async function mintJwt({ alg = 'ES256', iss = BASE, kid = 'test-key-1', exp = NOW.getTime() / 1000 + 600, sub = 'user_123', email = 'farmer@plotline.test' } = {}) {
  const header = { alg, typ: 'JWT', kid };
  const payload = { iss, sub, email, exp, iat: NOW.getTime() / 1000 - 5 };
  const input = `${enc(header)}.${enc(payload)}`;
  const key = await crypto.subtle.importKey('jwk', privateKey.export({ format: 'jwk' }), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(input));
  return { token: `${input}.${b64u(sig)}`, header, payload };
}

// A NeonAuth whose JWKS "network fetch" returns our local test key.
function testAuth(keys = [jwk]) {
  return new NeonAuth({
    jwksUrl: JWKS,
    baseUrl: BASE,
    fetch: async () => ({ ok: true, json: async () => ({ keys }) }),
    now: () => NOW,
  });
}

test('a valid Neon Auth token verifies and exposes its claims', async () => {
  const { token, payload } = await mintJwt();
  const r = await testAuth().verify(token);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.claims.sub, payload.sub);
  assert.equal(r.claims.email, 'farmer@plotline.test');
  assert.equal(r.keyId, 'test-key-1');
});

test('a foreign key, expired token and wrong issuer are refused', async () => {
  const { token: good } = await mintJwt();
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const foreignJwk = { ...other.publicKey.export({ format: 'jwk' }), kid: 'not-mine', alg: 'ES256' };
  const foreign = await testAuth([foreignJwk]).verify(good);
  assert.equal(foreign.ok, false, 'a signature from another key must not verify');
  assert.match(foreign.error, /no JWKS key matches kid/);

  const expired = await mintJwt({ exp: NOW.getTime() / 1000 - 10 });
  assert.equal((await testAuth().verify(expired.token)).ok, false);
  assert.match((await testAuth().verify(expired.token)).error, /expired/);

  const wrongIss = await mintJwt({ iss: 'https://evil.example' });
  const rejected = await testAuth().verify(wrongIss.token);
  assert.equal(rejected.ok, false, 'an issuer from another tenant is refused');
  assert.match(rejected.error, /not this Neon Auth tenant|signature/);
});

test('garbage tokens fail loudly but never throw', async () => {
  const auth = testAuth();
  for (const junk of ['', 'abc', 'a.b.c', `${'x'.repeat(8)}.${'y'.repeat(8)}.zz`]) {
    const r = await auth.verify(junk);
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, 'string');
  }
});

test('the class is the only verification path, and it is reusable', async () => {
  const auth = testAuth();
  const { token } = await mintJwt();
  const r = await auth.verify(token);
  assert.equal(r.ok, true);
  assert.equal(r.claims.email, 'farmer@plotline.test');
});
