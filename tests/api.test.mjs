// Run: node tests/api.test.mjs
//
// Covers the two pure pieces of session handling: pulling a session out of
// whatever the user pasted, and deriving the rate-key header.
//
// The storage accessors (session/setSession/clearSession) are not covered —
// they touch sessionStorage, which node has no equivalent of, and they are thin
// wrappers over a JSON round-trip. They are exercised in the browser.
//
// Every value below is synthetic — a made-up 32-hex session id and a dummy
// UUID. Do not paste a live session in here to debug: this file is committed.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { ApiError, parseSession, rateKey } from "../app/api.js";

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
const checkAsync = async (name, fn) => {
  try {
    await fn();
    pass++;
  } catch (e) {
    fails.push(`${name}: ${e.message}`);
  }
};

const SID = "A1B2C3D4E5F60718293A4B5C6D7E8F90"; // 32 hex, not a real session
const SUB = "11111111-2222-3333-4444-555555555555";

// --- parsing what the user pasted -------------------------------------------

const CURL = `curl 'https://times-api.usaswimming.org/swims/TimesSearch/GetBestTimesForMember/10956C3382EB4B' \\
  -H 'accept: */*' \\
  -H 'appname: DataHub' \\
  -H 'device-id: TWFjSW50ZWwgLSBHb29nbGU=' \\
  -H 'origin: https://data.usaswimming.org' \\
  -H 'rate-key: 9296.3ed5f8821e123' \\
  -H 'usas-session-id: ${SID}' \\
  -H 'usas-sub-id: ${SUB}' \\
  -H 'user-agent: Mozilla/5.0'`;

check("reads a session out of a copied cURL", () => {
  assert.deepEqual(parseSession(CURL), { sessionId: SID, subId: SUB });
});

check("handles double-quoted headers, as Windows DevTools emits", () => {
  const win = `curl "https://times-api.usaswimming.org/x" -H "usas-session-id: ${SID}" -H "usas-sub-id: ${SUB}"`;
  assert.deepEqual(parseSession(win), { sessionId: SID, subId: SUB });
});

check("header names are matched case-insensitively", () => {
  const mixed = `-H 'Usas-Session-Id: ${SID}' -H 'USAS-SUB-ID: ${SUB}'`;
  assert.deepEqual(parseSession(mixed), { sessionId: SID, subId: SUB });
});

check("falls back to shape for two bare values", () => {
  // Told apart by shape, not order: 32 hex is the session, a UUID is the sub.
  assert.deepEqual(parseSession(`${SID} ${SUB}`), { sessionId: SID, subId: SUB });
  assert.deepEqual(parseSession(`${SUB}\n${SID}`), { sessionId: SID, subId: SUB });
});

check("an anonymous request yields no session", () => {
  // Copying a cURL before signing in is the likeliest mistake.
  const anon = `-H 'appname: DataHub' -H 'usas-sub-id: Anonymous' -H 'device-id: abc'`;
  assert.equal(parseSession(anon), null);
});

check("half a session is not a session", () => {
  assert.equal(parseSession(`-H 'usas-session-id: ${SID}'`), null);
  assert.equal(parseSession(`-H 'usas-sub-id: ${SUB}'`), null);
});

check("junk and empty input are null, never a throw", () => {
  for (const v of ["", "   ", "hello", null, undefined, 42, {}]) {
    assert.equal(parseSession(v), null, `input ${JSON.stringify(v)}`);
  }
});

check("the device-id in the paste is not mistaken for a session", () => {
  // A base64 device-id can contain long hex-ish runs; only a clean 32-hex token
  // standing alone should qualify.
  const got = parseSession(CURL);
  assert.equal(got.sessionId, SID);
  assert.notEqual(got.sessionId, "TWFjSW50ZWwgLSBHb29nbGU=");
});

// --- rate-key ---------------------------------------------------------------

await checkAsync("rate-key matches an independent HMAC of the time bucket", async () => {
  const got = await rateKey(SID);
  const [prefix, hex] = got.split(".");

  const bucket = Math.floor(Date.now() / 10_000).toString();
  const expected = createHmac("sha256", SID).update(bucket).digest("hex");
  assert.equal(hex, expected, "HMAC body must be SHA-256 over the 10s bucket, keyed by the sid");

  const now = Date.now();
  const midnight = new Date(now);
  midnight.setUTCHours(0, 0, 0, 0);
  const secondsToday = Math.floor((now - midnight.getTime()) / 1000) || 1;
  assert.equal(prefix, String(Math.floor(Number(bucket) / secondsToday)));
});

await checkAsync("rate-key is shaped prefix.hex64", async () => {
  assert.match(await rateKey(SID), /^\d+\.[0-9a-f]{64}$/);
});

await checkAsync("a different session id gives a different key", async () => {
  const a = await rateKey(SID);
  const b = await rateKey("0000000000000000000000000000FFFF");
  assert.notEqual(a.split(".")[1], b.split(".")[1]);
});

// --- error semantics --------------------------------------------------------

check("a 403 carries needsSession so the UI can prompt", () => {
  const err = new ApiError("nope", 403, { needsSession: true });
  assert.equal(err.status, 403);
  assert.equal(err.needsSession, true);
  assert.ok(err instanceof Error);
});

check("other errors do not ask for a sign-in", () => {
  assert.equal(new ApiError("boom", 500).needsSession, false);
});

console.log(`\n${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
process.exit(fails.length ? 1 : 0);
