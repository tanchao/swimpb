// Run: node tests/api.test.mjs
//
// Covers session parsing and ApiError semantics.
//
// The storage accessors (session/setSession/clearSession) are not covered —
// they touch sessionStorage, which node has no equivalent of, and they are thin
// wrappers over a JSON round-trip.
//
// Every value below is synthetic. Do not paste a live session in here to debug:
// this file is committed.

import assert from "node:assert/strict";
import { ApiError, parseSession } from "../app/api.js";

let pass = 0;
const fails = [];
const check = (name, fn) => {
  try {
    const r = fn();
    if (r instanceof Promise) throw new Error("use checkAsync for async checks");
    pass++;
  } catch (e) {
    fails.push(`${name}: ${e.message}`);
  }
};

const BFF = "CfDJ8SyntheticBffSessionCookieValueForTesting0123456789_abcdef-GHIJKL";

// --- parsing what the user pasted -------------------------------------------

const CURL = `curl --url 'https://data.usaswimming.org/api/times/swims/TimesSearch/GetBestTimesForMember/10956C3382EB4B' \\
  -H 'Accept: */*' \\
  -b 'bff_auth_session=${BFF}' \\
  -H 'Device-Id: TWFjSW50ZWwgLSBHb29nbGU=' \\
  -H 'X-CSRF: 1'`;

check("reads bff_auth_session out of a copied cURL (-b)", () => {
  assert.deepEqual(parseSession(CURL), { bffSession: BFF });
});

check("handles double-quoted cookies and multiple cookies in -b", () => {
  const win = `curl "https://data.usaswimming.org/api/times/swims/x" -b "other=1; bff_auth_session=${BFF}; foo=bar"`;
  assert.deepEqual(parseSession(win), { bffSession: BFF });
});

check("handles -H 'Cookie: ...' and --cookie flags", () => {
  assert.deepEqual(parseSession(`-H 'Cookie: a=1; bff_auth_session=${BFF}'`), { bffSession: BFF });
  assert.deepEqual(parseSession(`--cookie 'bff_auth_session=${BFF}'`), { bffSession: BFF });
});

check("handles key=value or bare CfDJ8 cookie value", () => {
  assert.deepEqual(parseSession(`bff_auth_session=${BFF}`), { bffSession: BFF });
  assert.deepEqual(parseSession(`  ${BFF}\n`), { bffSession: BFF });
});

check("keeps base64 characters in the cookie value", () => {
  const token = `${BFF}/abc+def=`;
  assert.deepEqual(parseSession(`bff_auth_session=${token}`), { bffSession: token });
  assert.deepEqual(parseSession(token), { bffSession: token });
});

check("an anonymous request without bff_auth_session yields null", () => {
  const anon = `curl 'https://data.usaswimming.org/api/times/swims/x' -H 'Device-Id: TWFjSW50ZWwgLSBHb29nbGU=' -H 'X-CSRF: 1'`;
  assert.equal(parseSession(anon), null);
});

check("other CfDJ8 cookies (like OIDC nonces) in a cURL are not mistaken for bff_auth_session", () => {
  const nonce = `curl 'https://data.usaswimming.org/x' -b '.AspNetCore.OpenIdConnect.Nonce.${BFF}=N'`;
  assert.equal(parseSession(nonce), null);
});

check("junk and empty input are null, never a throw", () => {
  for (const v of ["", "   ", "hello", null, undefined, 42, {}]) {
    assert.equal(parseSession(v), null, `input ${JSON.stringify(v)}`);
  }
});

// --- error semantics --------------------------------------------------------

check("a 401/403 carries needsSession so the UI can prompt", () => {
  const err = new ApiError("nope", 401, { needsSession: true });
  assert.equal(err.status, 401);
  assert.equal(err.needsSession, true);
  assert.ok(err instanceof Error);
});

check("other errors do not ask for a sign-in", () => {
  assert.equal(new ApiError("boom", 500).needsSession, false);
});

console.log(`\n${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
process.exit(fails.length ? 1 : 0);
