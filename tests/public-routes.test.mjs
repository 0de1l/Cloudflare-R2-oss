import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

const root = process.cwd();

async function loadRoute(entry) {
  const result = await build({
    absWorkingDir: root,
    bundle: true,
    entryPoints: [path.join(root, entry)],
    format: "esm",
    platform: "browser",
    plugins: [{
      name: "workspace-alias",
      setup(build) {
        build.onResolve({ filter: /^@\// }, (args) => ({
          path: `${path.join(root, args.path.slice(2))}.ts`,
        }));
      },
    }],
    write: false,
  });
  const code = Buffer.from(result.outputFiles[0].contents).toString("base64");
  return import(`data:text/javascript;base64,${code}`);
}

const [children, raw, writes, session, s3, writeTest, buckets, login, logout] = await Promise.all([
  loadRoute("functions/api/children/[[path]].ts"),
  loadRoute("functions/raw/[[path]].ts"),
  loadRoute("functions/api/write/items/[[path]].ts"),
  loadRoute("functions/api/auth/session.ts"),
  loadRoute("functions/api/write/s3/[[path]].ts"),
  loadRoute("functions/api/write/test/[[path]].ts"),
  loadRoute("functions/api/buckets.ts"),
  loadRoute("functions/api/auth/login.ts"),
  loadRoute("functions/api/auth/logout.ts"),
]);

const objects = {
  "public/readme.txt": "Public text",
  "private/secret.txt": "Private text",
  "public-other/secret.txt": "Outside the public folder",
  "docs/readme.txt": "Scoped account text",
  "_$flaredrive$/thumbnails/test.png": "Internal thumbnail",
};

function makeContext(pathname, { cookie = "", env = {}, method = "GET", body, headers: extraHeaders } = {}) {
  const url = new URL(pathname, "https://drive.example.test/");
  const key = url.pathname.replace(/^\/+/, "");
  const functionPath = key.replace(/^(?:raw|api\/children|api\/write\/(?:items|test|s3))\/?/, "");
  const bucket = {
    list: async ({ prefix }) => ({
      objects: Object.keys(objects)
        .filter((objectKey) => objectKey.startsWith(prefix))
        .map((objectKey) => ({
          key: objectKey,
          size: objects[objectKey].length,
          uploaded: new Date(0),
          httpMetadata: { contentType: "text/plain" },
          customMetadata: {},
        })),
      delimitedPrefixes: [],
    }),
    get: async (objectKey) => objects[objectKey] === undefined ? null : ({
      body: new Response(objects[objectKey]).body,
      httpEtag: '"test"',
      writeHttpMetadata(headers) {
        headers.set("content-type", "text/plain");
      },
    }),
    head: async (objectKey) => objects[objectKey] === undefined ? null : ({
      httpEtag: '"test"',
      writeHttpMetadata(headers) {
        headers.set("content-type", "text/plain");
      },
    }),
    put: async (objectKey) => ({ key: objectKey, size: 0, uploaded: new Date(0) }),
    delete: async () => { throw new Error("Unauthenticated delete reached R2"); },
  };
  const headers = new Headers(extraHeaders);
  if (cookie) headers.set("cookie", cookie.split(";")[0]);
  if (body !== undefined) headers.set("content-type", "application/json");
  const request = new Request(url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : body ?? "",
  });
  return {
    request,
    env: { BUCKET: bucket, SESSION_SECRET: "route-test-secret", ...env },
    params: { path: functionPath ? functionPath.split("/") : [] },
  };
}

async function adminCookie() {
  const response = await login.onRequestPost(makeContext("api/auth/login", {
    env: { AUTH_USERS: '{"admin:secret":"*"}' },
    method: "POST",
    body: JSON.stringify({ username: "admin", password: "secret" }),
  }));
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie");
}

test("login issues a non-cacheable v2 cookie and logout only clears the browser cookie", async () => {
  const env = { AUTH_USERS: '{"admin:secret":"*"}' };
  const response = await login.onRequestPost(makeContext("api/auth/login", {
    env, method: "POST", body: JSON.stringify({ username: "admin", password: "secret" }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "application/json");
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /^fd_session=v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+;/);
  for (const attribute of ["Path=/", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age=604800"]) {
    assert.ok(cookie.split("; ").includes(attribute), attribute);
  }
  const authenticated = await session.onRequestGet(makeContext("api/auth/session", { env, cookie }));
  assert.deepEqual(await authenticated.json(), {
    authenticated: true, home: "", publicRoot: "public/",
    publicUploadEnabled: false, maxPublicUploadBytes: 52428800, canManagePublic: true,
  });
  assert.equal((await raw.onRequestGet(makeContext("raw/private/secret.txt", { env, cookie }))).status, 200);

  const loggedOut = await logout.onRequestPost(makeContext("api/auth/logout", { env, cookie, method: "POST" }));
  assert.equal(loggedOut.status, 200);
  assert.deepEqual(await loggedOut.json(), { ok: true });
  assert.equal(loggedOut.headers.get("cache-control"), "no-store");
  assert.equal(loggedOut.headers.get("content-type"), "application/json");
  const cleared = loggedOut.headers.get("set-cookie");
  assert.equal(cleared, "fd_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
  const anonymous = await session.onRequestGet(makeContext("api/auth/session", { env, cookie: cleared }));
  assert.deepEqual(await anonymous.json(), {
    authenticated: false, home: "public/", publicRoot: "public/",
    publicUploadEnabled: false, maxPublicUploadBytes: 52428800, canManagePublic: false,
  });
  assert.equal((await raw.onRequestGet(makeContext("raw/private/secret.txt", { env, cookie: cleared }))).status, 401);
  assert.equal((await raw.onRequestGet(makeContext("raw/public/readme.txt", { env, cookie: cleared }))).status, 200);

  // Stateless logout cannot revoke another copy of the original bearer token.
  const copied = await session.onRequestGet(makeContext("api/auth/session", { env, cookie }));
  assert.equal((await copied.json()).authenticated, true);
  assert.equal((await raw.onRequestGet(makeContext("raw/private/secret.txt", { env, cookie }))).status, 200);
});

test("session capabilities expose public append separately from public management", async () => {
  const env = {
    AUTH_USERS: '{"admin:secret":"*","editor:secret":"public/,docs/"}',
    PUBLIC_UPLOAD_ENABLED: "true",
    PUBLIC_UPLOAD_MAX_BYTES: "100",
  };
  const guest = await session.onRequestGet(makeContext("api/auth/session", { env }));
  assert.deepEqual(await guest.json(), {
    authenticated: false, home: "public/", publicRoot: "public/",
    publicUploadEnabled: true, maxPublicUploadBytes: 100, canManagePublic: false,
  });

  const editorLogin = await login.onRequestPost(makeContext("api/auth/login", {
    env, method: "POST", body: JSON.stringify({ username: "editor", password: "secret" }),
  }));
  const editorCookie = editorLogin.headers.get("set-cookie");
  assert.equal(editorLogin.status, 200);
  const editor = await session.onRequestGet(makeContext("api/auth/session", { env, cookie: editorCookie }));
  assert.deepEqual(await editor.json(), {
    authenticated: true, home: "public/", publicRoot: "public/",
    publicUploadEnabled: true, maxPublicUploadBytes: 100, canManagePublic: false,
  });

  const adminLogin = await login.onRequestPost(makeContext("api/auth/login", {
    env, method: "POST", body: JSON.stringify({ username: "admin", password: "secret" }),
  }));
  const admin = await session.onRequestGet(makeContext("api/auth/session", {
    env, cookie: adminLogin.headers.get("set-cookie"),
  }));
  assert.equal((await admin.json()).canManagePublic, true);
});

test("login errors are non-cacheable and never set a session cookie", async () => {
  const env = { AUTH_USERS: '{"admin:secret":"*"}' };
  for (const [body, status, message] of [
    [JSON.stringify({ username: "admin", password: "wrong" }), 401, "Invalid credentials"],
    [JSON.stringify({ username: "unknown", password: "secret" }), 401, "Invalid credentials"],
    [JSON.stringify({ username: "admin", password: 123 }), 401, "Invalid credentials"],
    ["{", 400, "Invalid request"],
    ["null", 400, "Invalid request"],
  ]) {
    const response = await login.onRequestPost(makeContext("api/auth/login", { env, method: "POST", body }));
    assert.equal(response.status, status);
    assert.equal(await response.text(), message);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("set-cookie"), null);
  }
});

test("visitors can list the public directory but not the bucket root or sibling prefixes", async () => {
  const publicResponse = await children.onRequestGet(makeContext("api/children/public"));
  assert.equal(publicResponse.status, 200);
  assert.equal(publicResponse.headers.get("cache-control"), "no-store");
  assert.deepEqual((await publicResponse.json()).value.map((file) => file.key), ["public/readme.txt"]);

  assert.equal((await children.onRequestGet(makeContext("api/children"))).status, 401);
  assert.equal((await children.onRequestGet(makeContext("api/children/public-other"))).status, 401);
  assert.equal((await children.onRequestGet(makeContext("api/children/private"))).status, 401);
});

test("visitors can fetch public files by GET and HEAD only", async () => {
  const response = await raw.onRequestGet(makeContext("raw/public/readme.txt"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), "Public text");

  const head = await raw.onRequestHead(makeContext("raw/public/readme.txt", { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal((await raw.onRequestGet(makeContext("raw/public-other/secret.txt"))).status, 401);
  assert.equal((await raw.onRequestGet(makeContext("raw/private/secret.txt"))).status, 401);
  assert.equal((await raw.onRequestGet(makeContext("raw/public"))).status, 401);
});

test("the legacy GUEST binding cannot authorize write, copy, or delete routes", async () => {
  const env = { GUEST: "*" };
  assert.equal((await writes.onRequestPut(makeContext("api/write/items/public/new.txt", { method: "PUT", env }))).status, 401);
  assert.equal((await writes.onRequestPost(makeContext("api/write/items/public/new.txt?uploads", { method: "POST", env }))).status, 401);
  assert.equal((await writes.onRequestDelete(makeContext("api/write/items/public/old.txt", { method: "DELETE", env }))).status, 401);
});

test("admins retain public and private access and writes", async () => {
  const cookie = await adminCookie();
  const env = { AUTH_USERS: '{"admin:secret":"*"}' };
  const publicList = await children.onRequestGet(makeContext("api/children/public", { cookie, env }));
  const privateRead = await raw.onRequestGet(makeContext("raw/private/secret.txt", { cookie, env }));
  assert.equal(publicList.status, 200);
  assert.equal(privateRead.status, 200);
  assert.equal(await privateRead.text(), "Private text");
  assert.equal((await writes.onRequestPut(makeContext("api/write/items/public/new.txt", { cookie, method: "PUT", env }))).status, 200);
});

test("directory listing accepts a trailing slash without changing the R2 prefix", async () => {
  const response = await children.onRequestGet(makeContext("api/children/public/"));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).value.map((file) => file.key), ["public/readme.txt"]);
});

test("limited accounts can list their directory root but cannot read a sibling or copy private files", async () => {
  const { authenticate } = await import("../utils/auth.ts");
  const env = { AUTH_USERS: '{"editor:secret":"docs/"}' };
  const cookie = await authenticate(makeContext("", { env }), "editor", "secret");
  for (const pathname of ["api/children/docs", "api/children/docs/"]) {
    const response = await children.onRequestGet(makeContext(pathname, { env, cookie }));
    assert.equal(response.status, 200, pathname);
    assert.deepEqual((await response.json()).value.map((file) => file.key), ["docs/readme.txt"]);
  }
  assert.equal((await raw.onRequestGet(makeContext("raw/private/secret.txt", { env, cookie }))).status, 401);
  assert.equal((await writes.onRequestPut(makeContext("api/write/items/docs/copy.txt", {
    env, cookie, method: "PUT", headers: { "x-amz-copy-source": "private%2Fsecret.txt" },
  }))).status, 401);
  const escapedSource = makeContext("api/write/items/docs/copy.txt", {
    env, cookie, method: "PUT", headers: { "x-amz-copy-source": "docs%252Fsecret.txt" },
  });
  escapedSource.env.BUCKET.get = () => { throw new Error("Escaped sibling source reached R2"); };
  assert.equal((await writes.onRequestPut(escapedSource)).status, 401);
});

test("session endpoint remains anonymous despite the public directory being readable", async () => {
  const response = await session.onRequestGet(makeContext("api/auth/session"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).authenticated, false);
  const cookie = await adminCookie();
  const authenticated = await session.onRequestGet(makeContext("api/auth/session", {
    cookie, env: { AUTH_USERS: '{"admin:secret":"*"}' },
  }));
  assert.equal((await authenticated.json()).authenticated, true);
});

test("HEAD uses only metadata and protects private files and internal thumbnails", async () => {
  const context = makeContext("raw/public/readme.txt", { method: "HEAD" });
  context.env.BUCKET.get = () => { throw new Error("HEAD must not read the object body"); };
  const response = await raw.onRequestHead(context);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("etag"), '"test"');
  assert.equal(response.headers.get("cache-control"), "no-store");
  for (const pathname of ["raw/private/secret.txt", "raw/_$flaredrive$/thumbnails/test.png"]) {
    assert.equal((await raw.onRequestHead(makeContext(pathname, { method: "HEAD" }))).status, 401);
    assert.equal((await raw.onRequestGet(makeContext(pathname))).status, 401);
  }
});

test("anonymous multipart, copy, S3, bucket discovery and write probes remain denied", async () => {
  const env = { GUEST: "*" };
  for (const [method, handler, suffix, headers] of [
    ["POST", writes.onRequestPost, "?uploads"],
    ["POST", writes.onRequestPost, "?uploadId=test"],
    ["PUT", writes.onRequestPut, "?uploadId=test&partNumber=1"],
    ["PUT", writes.onRequestPut, "", { "x-amz-copy-source": "public%2Freadme.txt" }],
  ]) {
    const response = await handler(makeContext(`api/write/items/public/new.txt${suffix}`, { method, env, headers }));
    assert.equal(response.status, 401);
  }
  assert.equal((await s3.onRequest(makeContext("api/write/s3/public/readme.txt", { env }))).status, 401);
  assert.equal((await buckets.onRequestGet(makeContext("api/buckets", { env }))).status, 401);
  assert.equal((await writeTest.onRequest(makeContext("api/write/test/public/readme.txt", { env }))).status, 401);
});

test("directory permissions decode percent-encoded keys exactly once", async () => {
  const { authenticate } = await import("../utils/auth.ts");
  const env = { AUTH_USERS: '{"editor:secret":"docs%/"}' };
  const cookie = await authenticate(makeContext("", { env }), "editor", "secret");
  const context = makeContext("api/children/docs%25", { env, cookie });
  let prefix;
  context.env.BUCKET.list = async (options) => {
    prefix = options.prefix;
    return { objects: [], delimitedPrefixes: [] };
  };
  assert.equal((await children.onRequestGet(context)).status, 200);
  assert.equal(prefix, "docs%/");
  assert.equal((await raw.onRequestGet(makeContext("raw/docs%25", { env, cookie }))).status, 401);
});

test("malformed and encoded traversal paths cannot reach R2 reads", async () => {
  for (const pathname of ["public/%ZZ", "public/%2e%2e%2fprivate/secret.txt"]) {
    const context = makeContext(`raw/${pathname}`);
    context.env.BUCKET.get = () => { throw new Error("Invalid path reached R2"); };
    context.env.BUCKET.head = () => { throw new Error("Invalid path reached R2"); };
    assert.equal((await raw.onRequestGet(context)).status, 401);
    assert.equal((await raw.onRequestHead(context)).status, 401);
  }
});

test("public management rejects ordinary prefix grants across all legacy upload paths", async () => {
  const { authenticate } = await import("../utils/auth.ts");
  for (const permissions of ["docs/", "public/,docs/", "public,docs/", "public%2F,docs/"]) {
    const env = { AUTH_USERS: JSON.stringify({ "editor:secret": permissions }) };
    const cookie = await authenticate(makeContext("", { env }), "editor", "secret");
    for (const key of ["public", "public/", "public/file.txt", "%70ublic/file.txt", "public%2Ffile.txt", "public/new/"]) {
      for (const [method, handler, suffix] of [
        ["PUT", writes.onRequestPut, ""],
        ["DELETE", writes.onRequestDelete, ""],
        ["POST", writes.onRequestPost, "?uploads"],
        ["POST", writes.onRequestPost, "?uploadId=test"],
        ["PUT", writes.onRequestPut, "?uploadId=test&partNumber=1"],
        ["POST", writes.onRequestPostCreateMultipart, "?uploads"],
        ["POST", writes.onRequestPostCompleteMultipart, "?uploadId=test"],
        ["PUT", writes.onRequestPutMultipart, "?uploadId=test&partNumber=1"],
        ["GET", writeTest.onRequest, ""],
      ]) {
        const context = makeContext(`api/write/items/${key}${suffix}`, { env, cookie, method });
        context.env.BUCKET = new Proxy({}, { get() { throw new Error("Denied management reached R2"); } });
        assert.equal((await handler(context)).status, 401, `${permissions}: ${handler.name} ${key}`);
      }
    }
  }
});

test("write authorization validates encoded paths once and retains private and thumbnail rules", async () => {
  const { authenticate, get_auth_status, get_write_auth_status } = await import("../utils/auth.ts");
  const env = { AUTH_USERS: '{"editor:secret":"public/,docs/,public%2F/"}' };
  const cookie = await authenticate(makeContext("", { env }), "editor", "secret");
  const context = makeContext("api/write/items/docs/file.txt", { env, cookie });
  assert.equal(await get_auth_status(context, "public/file.txt"), true);
  for (const key of ["public", "public/", "%70ublic/file.txt", "public%2Ffile.txt", "public/%2e%2e/private", "public/%ZZ"]) {
    assert.equal(await get_write_auth_status(context, key), false, key);
  }
  for (const key of ["docs/file.txt", "public%252F/file.txt", "_$flaredrive$/thumbnails/test.png"]) {
    assert.equal(await get_write_auth_status(context, key), true, key);
  }
  assert.equal(await get_write_auth_status(context, "docs-other/file.txt"), false);
  assert.equal(await get_write_auth_status(makeContext("api/write/items/_$flaredrive$/thumbnails/test.png")), false);
});

test("copying a public source requires admin even with an authorized private destination", async () => {
  const { authenticate } = await import("../utils/auth.ts");
  const env = { AUTH_USERS: '{"editor:secret":"public/,docs/"}' };
  const cookie = await authenticate(makeContext("", { env }), "editor", "secret");
  for (const source of ["public%2Freadme.txt", "%70ublic/readme.txt", "public/readme.txt"]) {
    const context = makeContext("api/write/items/docs/copy.txt", {
      env, cookie, method: "PUT", headers: { "x-amz-copy-source": source },
    });
    context.env.BUCKET.get = () => { throw new Error("Denied public copy source reached R2"); };
    assert.equal((await writes.onRequestPut(context)).status, 401, source);
  }
});

test("admin cleanup and private scoped multipart retain their existing behavior", async () => {
  const { authenticate } = await import("../utils/auth.ts");
  const adminEnv = { AUTH_USERS: '{"admin:secret":"docs/,*"}' };
  const cookie = await authenticate(makeContext("", { env: adminEnv }), "admin", "secret");
  const deletion = makeContext("api/write/items/public/readme.txt", { env: adminEnv, cookie, method: "DELETE" });
  let deleted;
  deletion.env.BUCKET.delete = async (key) => { deleted = key; };
  assert.equal((await writes.onRequestDelete(deletion)).status, 204);
  assert.equal(deleted, "public/readme.txt");
  assert.equal((await writeTest.onRequest(makeContext("api/write/test/public/", { env: adminEnv, cookie }))).status, 200);

  const env = { AUTH_USERS: '{"editor:secret":"docs/"}' };
  const privateCookie = await authenticate(makeContext("", { env }), "editor", "secret");
  const calls = [];
  const bucket = {
    createMultipartUpload: async (key) => { calls.push(["create", key]); return { key, uploadId: "test" }; },
    resumeMultipartUpload: async (key, uploadId) => ({
      uploadPart: async (partNumber) => { calls.push(["part", key, uploadId, partNumber]); return { etag: "part-etag" }; },
      complete: async (parts) => { calls.push(["complete", key, uploadId, parts]); return { httpEtag: '"complete"' }; },
    }),
  };
  for (const [method, handler, suffix, body] of [
    ["POST", writes.onRequestPost, "?uploads"],
    ["PUT", writes.onRequestPut, "?uploadId=test&partNumber=1", "part"],
    ["POST", writes.onRequestPost, "?uploadId=test", JSON.stringify({ parts: [{ partNumber: 1, etag: "part-etag" }] })],
  ]) {
    const response = await handler(makeContext(`api/write/items/docs/large.bin${suffix}`, {
      env: { ...env, BUCKET: bucket }, cookie: privateCookie, method, body,
    }));
    assert.equal(response.status, 200);
  }
  assert.deepEqual(calls, [
    ["create", "docs/large.bin"],
    ["part", "docs/large.bin", "test", 1],
    ["complete", "docs/large.bin", "test", [{ partNumber: 1, etag: "part-etag" }]],
  ]);
});

test("public GET and HEAD replace unsafe legacy metadata using a strict extension policy", async () => {
  for (const [filename, type, disposition] of [
    ["photo.PNG", "image/png", "inline"],
    ["sound.mp3", "audio/mpeg", "inline"],
    ["video.mp4", "video/mp4", "inline"],
    ["readme.txt", "text/plain; charset=utf-8", "inline"],
    ["payload.html", "application/octet-stream", "attachment"],
    ["payload.svg", "application/octet-stream", "attachment"],
    ["payload.js", "application/octet-stream", "attachment"],
    ["payload.pdf", "application/octet-stream", "attachment"],
    ["unknown", "application/octet-stream", "attachment"],
    ["image.png.html", "application/octet-stream", "attachment"],
    ["constructor", "application/octet-stream", "attachment"],
  ]) {
    const responses = [];
    for (const [method, handler] of [["GET", raw.onRequestGet], ["HEAD", raw.onRequestHead]]) {
      const context = makeContext(`raw/public/${filename}`, { method });
      const object = {
        body: new Response("<script>fetch('/api/write/items/public/file', {method:'DELETE'})</script>").body,
        httpEtag: '"public-test"',
        writeHttpMetadata(headers) {
          headers.set("content-type", "text/html");
          headers.set("content-encoding", "gzip");
          headers.set("content-disposition", "inline");
          headers.set("cache-control", "public, max-age=3600");
        },
      };
      context.env.BUCKET.get = async () => object;
      context.env.BUCKET.head = async () => object;
      const response = await handler(context);
      assert.equal(response.status, 200, filename);
      assert.equal(response.headers.get("content-type"), type, filename);
      assert.match(response.headers.get("content-disposition"), new RegExp(`^${disposition};`));
      assert.equal(response.headers.get("content-encoding"), null);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.match(response.headers.get("content-security-policy"), /(?:^|;)\s*sandbox(?:;|$)/);
      assert.doesNotMatch(response.headers.get("content-security-policy"), /allow-scripts|allow-same-origin/);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("etag"), '"public-test"');
      if (method === "HEAD") assert.equal(await response.text(), "");
      responses.push(Object.fromEntries(response.headers));
    }
    assert.deepEqual(responses[0], responses[1], filename);
  }
});

test("public filename headers safely encode Unicode and control characters while private metadata is unchanged", async () => {
  const filename = '\u4e2d\u6587";\r\nreport.html';
  const context = makeContext(`raw/public/${encodeURIComponent(filename)}`);
  context.env.BUCKET.get = async () => ({ body: "file", httpEtag: '"test"' });
  const response = await raw.onRequestGet(context);
  const disposition = response.headers.get("content-disposition");
  assert.match(disposition, /^attachment; filename="[\x20-\x21\x23-\x5b\x5d-\x7e]*"; filename\*=UTF-8''/);
  assert.ok(disposition.endsWith(encodeURIComponent(filename)), disposition);
  assert.doesNotMatch(disposition, /[\r\n]/);

  const cookie = await adminCookie();
  const privateContext = makeContext("raw/private/secret.txt", { cookie, env: { AUTH_USERS: '{"admin:secret":"*"}' } });
  privateContext.env.BUCKET.get = async () => ({
    body: "private",
    httpEtag: '"test"',
    writeHttpMetadata(headers) {
      headers.set("content-type", "application/pdf");
      headers.set("content-disposition", "inline");
      headers.set("content-encoding", "gzip");
    },
  });
  const privateResponse = await raw.onRequestGet(privateContext);
  assert.equal(privateResponse.headers.get("content-type"), "application/pdf");
  assert.equal(privateResponse.headers.get("content-disposition"), "inline");
  assert.equal(privateResponse.headers.get("content-encoding"), "gzip");
  assert.equal(privateResponse.headers.get("content-security-policy"), null);
});
