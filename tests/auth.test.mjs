import assert from "node:assert/strict";
import test from "node:test";
import { authenticate, get_auth_status } from "../utils/auth.ts";

const secret = "test-only-session-secret";

function context(env, cookie = "", path = "") {
  return {
    env: { SESSION_SECRET: secret, ...env },
    request: new Request("https://example.test/", {
      headers: { Cookie: cookie.split(";")[0] },
    }),
    params: { path },
  };
}

test("legacy accounts can log in and access permitted directories", async () => {
  const env = { "editor:test-password": "docs/,shared/" };
  const cookie = await authenticate(context(env), "editor", "test-password");
  assert.ok(cookie);
  assert.equal(await get_auth_status(context(env, cookie, "docs/file.txt")), true);
  assert.equal(await get_auth_status(context(env, cookie, "private/file.txt")), false);
  assert.equal(await authenticate(context(env), "editor", "wrong-password"), null);
});

test("removing a legacy account invalidates its session", async () => {
  const cookie = await authenticate(context({ "admin:test-password": "*" }), "admin", "test-password");
  assert.equal(await get_auth_status(context({}, cookie)), false);
});

test("sessions require the current signing secret", async () => {
  const env = { "admin:test-password": "*" };
  const cookie = await authenticate(context(env), "admin", "test-password");
  assert.equal(await get_auth_status(context({ ...env, SESSION_SECRET: "rotated-secret" }, cookie)), false);
  assert.equal(await authenticate(context({ ...env, SESSION_SECRET: "" }), "admin", "test-password"), null);
});

test("guest permissions remain limited to the configured path and enabled routes", async () => {
  const env = { GUEST: "public/" };
  assert.equal(await get_auth_status(context(env, "", "public/file.txt")), true);
  assert.equal(await get_auth_status(context(env, "", "private/file.txt")), false);
  assert.equal(await get_auth_status(context(env, "", "public/file.txt"), undefined, false), false);
});

test("AUTH_USERS supports admin and directory-limited accounts", async () => {
  const env = { AUTH_USERS: JSON.stringify({
    "admin:test-password": "*",
    "editor:another-password": "docs/,shared/",
  }) };
  const admin = await authenticate(context(env), "admin", "test-password");
  const editor = await authenticate(context(env), "editor", "another-password");
  assert.ok(admin);
  assert.ok(editor);
  assert.equal(await get_auth_status(context(env, admin, "private/file.txt"), undefined, false), true);
  assert.equal(await get_auth_status(context(env, editor, "docs/file.txt"), undefined, false), true);
  assert.equal(await get_auth_status(context(env, editor, "shared/file.txt"), undefined, false), true);
  assert.equal(await get_auth_status(context(env, editor, "private/file.txt"), undefined, false), false);
  assert.equal(await authenticate(context(env), "editor", "wrong-password"), null);
});

test("changing the configured password revokes old credentials and sessions", async () => {
  const before = { AUTH_USERS: '{"admin:old-password":"*"}' };
  const after = { AUTH_USERS: '{"admin:new-password":"*"}' };
  const oldCookie = await authenticate(context(before), "admin", "old-password");
  assert.equal(await authenticate(context(after), "admin", "old-password"), null);
  assert.equal(await get_auth_status(context(after, oldCookie)), false);
  const newCookie = await authenticate(context(after), "admin", "new-password");
  assert.ok(newCookie);
  assert.equal(await get_auth_status(context(after, newCookie)), true);
});

test("AUTH_USERS takes precedence over old account variables", async () => {
  const legacy = { "admin:test-password": "*" };
  const cookie = await authenticate(context(legacy), "admin", "test-password");
  const restricted = { ...legacy, AUTH_USERS: '{"admin:test-password":"docs/"}' };
  assert.equal(await get_auth_status(context(restricted, cookie, "docs/file.txt")), true);
  assert.equal(await get_auth_status(context(restricted, cookie, "private/file.txt")), false);
  const removed = { ...legacy, AUTH_USERS: "{}" };
  assert.equal(await authenticate(context(removed), "admin", "test-password"), null);
  assert.equal(await get_auth_status(context(removed, cookie)), false);
});

for (const value of ["", "not-json", "null", "[]", '"text"', '{"admin:test-password":true}', '{"admin:test-password":""}']) {
  test(`invalid AUTH_USERS fails closed: ${value}`, async () => {
    const legacy = { "admin:test-password": "*" };
    const cookie = await authenticate(context(legacy), "admin", "test-password");
    const env = { ...legacy, AUTH_USERS: value };
    assert.equal(await authenticate(context(env), "admin", "test-password"), null);
    assert.equal(await get_auth_status(context(env, cookie)), false);
  });
}

test("non-string credentials are rejected", async () => {
  const env = { AUTH_USERS: '{"admin:test-password":"*"}' };
  assert.equal(await authenticate(context(env), ["admin"], "test-password"), null);
  assert.equal(await authenticate(context(env), "admin", ["test-password"]), null);
});
