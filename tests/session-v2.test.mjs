import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { authenticate, get_auth_status, get_session_info, clearSessionCookie } from "../utils/auth.ts";

const secret = "session-v2-test-secret-0123456789abcdef";
const account = "editor:password-not-for-the-browser";
const env = { AUTH_USERS: JSON.stringify({ [account]: "docs/" }), SESSION_SECRET: secret };
const maxAge = 7 * 24 * 60 * 60;
const subject = (key = account) => createHmac("sha256", secret)
  .update(JSON.stringify(["account-id-v2", key])).digest("base64url");
const context = (cookie = "", bindings = env, path = "docs/file.txt") => ({
  env: bindings,
  request: new Request("https://drive.test/", { headers: { cookie: cookie.split(";")[0] } }),
  params: { path },
});
const payload = () => {
  const iat = Math.floor(Date.now() / 1000);
  return { sub: subject(), iat, exp: iat + maxAge, nonce: Buffer.alloc(16, 7).toString("base64url") };
};
function signedEncoded(encoded, version = "v2", domain = "session-v2:") {
  const message = `${version}.${encoded}`;
  const signature = createHmac("sha256", secret).update(`${domain}${message}`).digest("base64url");
  return `fd_session=${message}.${signature}`;
}
const signed = (value) => signedEncoded(Buffer.from(JSON.stringify(value)).toString("base64url"));

test("v2 cookies contain only opaque session fields and use a fresh nonce per login", async () => {
  const first = await authenticate(context(), "editor", "password-not-for-the-browser");
  const second = await authenticate(context(), "editor", "password-not-for-the-browser");
  const parts = first.split(";")[0].slice("fd_session=".length).split(".");
  assert.equal(parts[0], "v2");
  assert.equal(parts.length, 3);
  assert.ok(first.length < 1024);
  const decoded = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  assert.deepEqual(Object.keys(decoded).sort(), ["exp", "iat", "nonce", "sub"]);
  assert.equal(decoded.sub, subject());
  assert.equal(decoded.exp - decoded.iat, maxAge);
  assert.equal(Buffer.from(decoded.nonce, "base64url").length, 16);
  assert.notEqual(first, second);
  const secondPayload = JSON.parse(Buffer.from(second.split(".")[1], "base64url").toString("utf8"));
  assert.notEqual(decoded.nonce, secondPayload.nonce);
  for (const credential of [account, "password-not-for-the-browser", Buffer.from(account).toString("base64url")]) {
    assert.equal(JSON.stringify(decoded).includes(credential), false);
  }
  const message = `${parts[0]}.${parts[1]}`;
  assert.equal(parts[2], createHmac("sha256", secret).update(`session-v2:${message}`).digest("base64url"));
  for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", `Max-Age=${maxAge}`]) {
    assert.ok(first.includes(attribute), attribute);
  }
  assert.equal(await get_auth_status(context(first)), true);
  assert.equal(await get_auth_status(context(second)), true);
});

test("legacy credential-bearing cookies are rejected even with a valid signature", async () => {
  const message = `${Buffer.from(account).toString("base64url")}.${Date.now()}`;
  const signature = createHmac("sha256", secret).update(message).digest("base64url");
  const cookie = `fd_session=${message}.${signature}`;
  assert.equal(await get_auth_status(context(cookie)), false);
  assert.deepEqual(await get_session_info(context(cookie)), { authenticated: false, home: "public/", publicRoot: "public/" });
});

test("v2 verification accepts an independently signed valid token", async () => {
  assert.equal(await get_auth_status(context(signed(payload()))), true);
});

test("v2 lifetime boundaries are enforced against a deterministic clock", async (t) => {
  let now = 1_700_000_000;
  t.mock.method(Date, "now", () => now * 1000);
  const cookie = signed(payload());
  assert.equal(await get_auth_status(context(cookie)), true);
  now += maxAge - 1;
  assert.equal(await get_auth_status(context(cookie)), true);
  now += 1;
  assert.equal(await get_auth_status(context(cookie)), false);
});

const invalidPayloads = {
  "unknown account": (p) => ({ ...p, sub: subject("removed:password") }),
  "raw account subject": (p) => ({ ...p, sub: account }),
  "short subject": (p) => ({ ...p, sub: "abc" }),
  "non-string subject": (p) => ({ ...p, sub: 42 }),
  "short nonce": (p) => ({ ...p, nonce: "abc" }),
  "non-string nonce": (p) => ({ ...p, nonce: null }),
  "padded nonce": (p) => ({ ...p, nonce: `${p.nonce}==` }),
  "noncanonical nonce": (p) => ({ ...p, nonce: `${p.nonce.slice(0, -1)}x` }),
  "missing field": (p) => { const { nonce, ...rest } = p; return rest; },
  "embedded permissions": (p) => ({ ...p, permissions: "*" }),
  "null payload": () => null,
  "array payload": () => [],
  "string payload": () => "text",
  "expired token": (p) => ({ ...p, iat: p.iat - maxAge - 60, exp: p.iat - 60 }),
  "expiry boundary": (p) => ({ ...p, iat: p.iat - maxAge, exp: p.iat }),
  "future issuance": (p) => ({ ...p, iat: p.iat + 3600, exp: p.exp + 3600 }),
  "excessive lifetime": (p) => ({ ...p, exp: p.exp + 1 }),
  "reversed timestamps": (p) => ({ ...p, exp: p.iat - 1 }),
  "zero lifetime": (p) => ({ ...p, exp: p.iat }),
  "negative issuance": (p) => ({ ...p, iat: -1 }),
  "fractional issuance": (p) => ({ ...p, iat: p.iat - 0.5 }),
  "fractional expiry": (p) => ({ ...p, exp: p.exp - 0.5 }),
  "string issuance": (p) => ({ ...p, iat: String(p.iat) }),
  "null expiry": (p) => ({ ...p, exp: null }),
  "unsafe issuance": (p) => ({ ...p, iat: Number.MAX_SAFE_INTEGER + 1 }),
  "unsafe expiry": (p) => ({ ...p, exp: Number.MAX_SAFE_INTEGER + 1 }),
};

for (const [name, mutate] of Object.entries(invalidPayloads)) {
  test(`v2 rejects correctly signed but invalid payload: ${name}`, async () => {
    assert.equal(await get_auth_status(context(signed(mutate(payload())))), false);
  });
}

test("v2 rejects bad framing, malformed encoding, tampering and cross-domain signatures", async () => {
  const good = signed(payload());
  const [version, encoded, signature] = good.slice("fd_session=".length).split(".");
  const tampered = Buffer.from(JSON.stringify({ ...payload(), sub: subject("admin:password") })).toString("base64url");
  for (const cookie of [
    "fd_session=", "fd_session=v2", `${good}.extra`,
    `fd_session=v1.${encoded}.${signature}`,
    signedEncoded(encoded, "v3"), signedEncoded(encoded, "v2", "account-id-v2:"),
    `fd_session=${version}.${tampered}.${signature}`,
    `fd_session=v2.${encoded}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`,
    `fd_session=v2.${encoded}.AAAA`, `fd_session=v2.${encoded}.${signature}=`,
    signedEncoded("%%%"), signedEncoded("a"), signedEncoded(`${encoded}=`),
    signedEncoded(Buffer.from("{").toString("base64url")),
    signedEncoded(Buffer.from([0xff, 0xfe]).toString("base64url")),
    signedEncoded("a".repeat(1100)),
  ]) {
    assert.equal(await get_auth_status(context(cookie)), false, cookie.slice(0, 50));
  }
});

test("live account configuration governs v2 revocation and permissions", async () => {
  const cookie = signed(payload());
  const restricted = { ...env, AUTH_USERS: JSON.stringify({ [account]: "other/" }) };
  assert.equal(await get_auth_status(context(cookie, restricted)), false);
  assert.equal(await get_auth_status(context(cookie, restricted, "other/readme.txt")), true);
  for (const bindings of [
    { ...env, AUTH_USERS: "{}" },
    { ...env, AUTH_USERS: JSON.stringify({ "editor:new-password": "docs/" }) },
    { ...env, SESSION_SECRET: "different-secret" },
    { ...env, AUTH_USERS: "invalid-json", [account]: "*" },
    { ...env, SESSION_SECRET: "" },
    { ...env, SESSION_SECRET: {} },
  ]) assert.equal(await get_auth_status(context(cookie, bindings)), false);
  // Stateless revocation follows current configuration, not a permanent blacklist.
  assert.equal(await get_auth_status(context(cookie, env)), true);
});

test("Unicode and colon-containing credentials round-trip without browser credential storage", async () => {
  const username = "\u7528\u6237:editor";
  const password = "\u5bc6\u7801:pass\u{1f511}";
  for (const bindings of [
    { SESSION_SECRET: secret, AUTH_USERS: JSON.stringify({ [`${username}:${password}`]: "docs/" }) },
    { SESSION_SECRET: secret, [`${username}:${password}`]: "docs/" },
  ]) {
    const cookie = await authenticate(context("", bindings), username, password);
    assert.ok(cookie);
    assert.equal(await get_auth_status(context(cookie, bindings)), true);
    assert.equal((await get_session_info(context(cookie, bindings))).home, "docs/");
  }
});

test("legacy environment matching ignores non-account bindings and invalid permissions", async () => {
  for (const [key, value] of [["BUCKET", "*"], [":password", "*"], ["editor:", "*"], [account, true], [account, ""]]) {
    const cookie = signed({ ...payload(), sub: subject(key) });
    assert.equal(await get_auth_status(context(cookie, { SESSION_SECRET: secret, [key]: value })), false);
  }
});

test("logout clears the browser cookie but cannot revoke a copied stateless token", async () => {
  const cookie = signed(payload());
  const cleared = clearSessionCookie();
  assert.match(cleared, /^fd_session=;/);
  assert.ok(cleared.includes("Max-Age=0"));
  for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) assert.ok(cleared.includes(attribute));
  assert.equal(await get_auth_status(context(cleared)), false);
  assert.equal(await get_auth_status(context(cookie)), true);
});
