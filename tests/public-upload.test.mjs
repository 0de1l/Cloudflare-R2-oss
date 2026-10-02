import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { FixedLengthStream } from "@miniflare/core";

globalThis.FixedLengthStream = FixedLengthStream;
const result = await build({
  entryPoints: ["functions/api/upload/public/[[name]].ts"], bundle: true,
  platform: "browser", format: "esm", write: false,
  plugins: [{ name: "alias", setup(build) {
    build.onResolve({ filter: /^@\// }, ({ path: name }) => ({ path: path.resolve(`${name.slice(2)}.ts`) }));
  } }],
});
const route = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);

function bucketFixture() {
  const objects = new Map();
  const calls = [];
  return {
    objects, calls,
    head() { throw new Error("Do not use HEAD as a create-only guard"); },
    delete() { throw new Error("Never delete a competing upload"); },
    async put(key, body, options) {
      calls.push({ key, options });
      assert.equal(options.onlyIf.get("if-none-match"), "*");
      if (objects.has(key)) return null;
      const bytes = await new Response(body).arrayBuffer();
      // Simulate R2's atomic condition at commit, not a HEAD-then-PUT race.
      if (objects.has(key)) return null;
      objects.set(key, new Uint8Array(bytes));
      return { key, size: bytes.byteLength, uploaded: new Date(0) };
    },
  };
}

function context({ name = "new.txt", body = "hello", length = "5", headers = {}, env = {}, bucket = bucketFixture(), query = "", signal } = {}) {
  const requestHeaders = new Headers(headers);
  if (length !== null) requestHeaders.set("content-length", length);
  return {
    request: new Request(`https://drive.test/api/upload/public/${name}${query}`, {
      method: "PUT", headers: requestHeaders, body, duplex: "half", signal,
    }),
    params: { name: name === "" ? [] : [name] },
    env: { BUCKET: bucket, PUBLIC_UPLOAD_ENABLED: "true", PUBLIC_UPLOAD_MAX_BYTES: "8", ...env },
  };
}
const settle = () => new Promise(setImmediate);

test("public append is explicitly enabled and configuration fails closed", async () => {
  for (const env of [
    { PUBLIC_UPLOAD_ENABLED: undefined }, { PUBLIC_UPLOAD_ENABLED: "false" },
    { PUBLIC_UPLOAD_ENABLED: "yes" }, { PUBLIC_UPLOAD_MAX_BYTES: "0" },
    { PUBLIC_UPLOAD_MAX_BYTES: "-1" }, { PUBLIC_UPLOAD_MAX_BYTES: "abc" },
    { PUBLIC_UPLOAD_MAX_BYTES: "52428801" }, { PUBLIC_UPLOAD_MAX_BYTES: "1.5" },
  ]) {
    const ctx = context({ env });
    assert.equal((await route.onRequestPut(ctx)).status, 503);
    assert.equal(ctx.env.BUCKET.calls.length, 0);
  }
  assert.equal((await route.onRequestPut(context({ env: { PUBLIC_UPLOAD_MAX_BYTES: undefined } }))).status, 201);
});

test("anonymous uploads create a file at public root using actual bytes and safe metadata", async () => {
  const ctx = context({ name: "100%25%20%23%3F.txt", headers: { "content-type": "text/html" } });
  const response = await route.onRequestPut(ctx);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).key, "public/100% #?.txt");
  assert.equal(new TextDecoder().decode(ctx.env.BUCKET.objects.get("public/100% #?.txt")), "hello");
  assert.equal(ctx.env.BUCKET.calls[0].options.httpMetadata.contentType, "application/octet-stream");
});

test("size limits accept L-1 and L, reject L+1, and do not trust declared length", async () => {
  for (const size of [7, 8]) assert.equal((await route.onRequestPut(context({ body: "x".repeat(size), length: String(size) }))).status, 201);
  for (const [body, length, status] of [["123456789", "9", 413], ["123456789", "8", 413], ["123456", "5", 400], ["1234", "5", 400]]) {
    const ctx = context({ body, length });
    assert.equal((await route.onRequestPut(ctx)).status, status);
    assert.equal(ctx.env.BUCKET.objects.size, 0);
  }
  const tooLarge = context({ body: "", length: "52428801", env: { PUBLIC_UPLOAD_MAX_BYTES: undefined } });
  assert.equal((await route.onRequestPut(tooLarge)).status, 413);
  assert.equal(tooLarge.env.BUCKET.calls.length, 0);
  assert.equal((await route.onRequestPut(context({ body: null, length: "0" }))).status, 201);
});

test("invalid lengths, names, encodings and privileged request options cannot reach R2", async () => {
  const cases = [
    [{ length: null }, 411], [{ length: "-1" }, 400], [{ length: "1.5" }, 400],
    [{ length: "5e0" }, 400], [{ length: "9007199254740992" }, 400],
    ...["", ".", "..", "%2e%2e", "a%2Fb.txt", "a%5Cb.txt", "%00.txt", "%0d%0a.txt", "_$folder$", "_$flaredrive$", "%zz", "a".repeat(1020)].map(name => [{ name }, 400]),
    [{ query: "?uploads" }, 400], [{ query: "?uploadId=secret&partNumber=1" }, 400],
    [{ headers: { "x-amz-copy-source": "private/file" } }, 400],
    [{ headers: { "fd-thumbnail": "private" } }, 400],
    [{ headers: { "x-amz-meta-anything": "not allowed" } }, 400],
    [{ headers: { "content-encoding": "gzip" } }, 415],
  ];
  for (const [options, status] of cases) {
    const ctx = context(options);
    assert.equal((await route.onRequestPut(ctx)).status, status, JSON.stringify(options));
    assert.equal(ctx.env.BUCKET.calls.length, 0);
  }
  const ctx = context(); ctx.params.name = ["nested", "file.txt"];
  assert.equal((await route.onRequestPut(ctx)).status, 400);
});

test("twenty same-name concurrent uploads have one winner under the R2 atomic contract", async () => {
  const bucket = bucketFixture();
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) => route.onRequestPut(context({
    bucket, body: String(index), length: String(String(index).length),
    headers: { "if-none-match": "fake", "if-match": "*" },
  }))));
  assert.equal(results.filter(r => r.status === 201).length, 1);
  assert.equal(results.filter(r => r.status === 409).length, 19);
  const winner = new TextDecoder().decode(bucket.objects.get("public/new.txt"));
  assert.ok(Array.from({ length: 20 }, (_, n) => String(n)).includes(winner));
  const response = await route.onRequestPut(context({ bucket }));
  assert.equal(response.status, 409);
  assert.equal(new TextDecoder().decode(bucket.objects.get("public/new.txt")), winner);
});

test("early conflicts and storage failures cancel the source without hanging or deleting", { timeout: 2000 }, async () => {
  for (const status of [409, 500]) {
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel() { cancelled = true; },
    });
    const bucket = {
      put: async () => { if (status === 409) return null; throw new Error("storage failed"); },
      delete: () => assert.fail("Must not delete the target"),
    };
    assert.equal((await route.onRequestPut(context({ bucket, body, length: "8" }))).status, status);
    await settle();
    assert.equal(cancelled, true);
  }
});

test("broken and aborted uploads never create partial objects", { timeout: 2000 }, async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.error(new Error("disconnect")); } });
  const ctx = context({ body, length: "8" });
  assert.ok((await route.onRequestPut(ctx)).status >= 400);
  assert.equal(ctx.env.BUCKET.objects.size, 0);
  const controller = new AbortController(); controller.abort();
  const aborted = context({ signal: controller.signal });
  assert.equal((await route.onRequestPut(aborted)).status, 400);
  assert.equal(aborted.env.BUCKET.objects.size, 0);
});

test("the advertised final byte is not published before validating end-of-input", { timeout: 3000 }, async () => {
  for (const failure of ["overflow", "disconnect", "abort", "empty-overflow"]) {
    const abort = new AbortController();
    let committed = false;
    const expected = failure === "empty-overflow" ? 0 : 5;
    const body = new ReadableStream({
      start(controller) {
        if (expected) controller.enqueue(new TextEncoder().encode("first"));
        setTimeout(() => {
          if (failure === "disconnect") controller.error(new Error("late disconnect"));
          else if (failure === "abort") abort.abort();
          else { controller.enqueue(new Uint8Array([1])); controller.close(); }
        }, 10);
      },
    });
    const bucket = {
      async put(key, stream) {
        // A known-length consumer may commit without waiting for readable EOF.
        const reader = stream?.getReader();
        let received = 0;
        try {
          while (received < expected) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error("incomplete");
            received += chunk.value.byteLength;
          }
          committed = true;
          return { key, size: received };
        } finally { reader?.releaseLock(); }
      },
    };
    const result = await route.onRequestPut(context({ body, bucket, length: String(expected), signal: abort.signal }));
    assert.ok(result.status >= 400, failure);
    assert.equal(committed, false, failure);
  }
});
