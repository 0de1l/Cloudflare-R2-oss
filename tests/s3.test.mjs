import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeQuery, S3Client } from "../utils/s3.ts";

test("SigV4 canonical query sorts encoded keys and values using RFC 3986 escaping", () => {
  const params = new URLSearchParams("z=last&b=!*()&a=hello+world&a=%7E");
  assert.equal(
    canonicalizeQuery(params),
    "a=hello%20world&a=~&b=%21%2A%28%29&z=last"
  );
});

test("SigV4 signatures do not depend on incoming query parameter order", async () => {
  const originalDate = globalThis.Date;
  const originalFetch = globalThis.fetch;
  const fixedTime = originalDate.parse("2024-01-02T03:04:05.000Z");
  const signatures = [];
  globalThis.Date = class extends originalDate {
    constructor(...args) { super(...(args.length ? args : [fixedTime])); }
    static now() { return fixedTime; }
  };
  globalThis.fetch = async (_input, init) => {
    signatures.push(new Headers(init.headers).get("authorization"));
    return new Response("ok");
  };

  try {
    const client = new S3Client("test-access", "test-secret");
    await client.s3_fetch("https://r2.example.test/bucket/key?z=last&a=first&a=second&tag=x%21");
    await client.s3_fetch("https://r2.example.test/bucket/key?tag=x!&a=second&z=last&a=first");
  } finally {
    globalThis.Date = originalDate;
    globalThis.fetch = originalFetch;
  }

  assert.equal(signatures.length, 2);
  assert.equal(signatures[0], signatures[1]);
});
