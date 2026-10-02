import { parseBucketPath } from "@/utils/bucket";
import { publicUploadSettings } from "@/utils/public-upload";

class UploadBodyError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function response(status: number, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function createOnly(bucket, key: string, request: Request, length: number, maximum: number) {
  const options = {
    onlyIf: new Headers({ "If-None-Match": "*" }),
    httpMetadata: { contentType: "application/octet-stream" },
  };
  if (length === 0) {
    await request.body?.pipeTo(new WritableStream({
      write(chunk) {
        if (chunk.byteLength) throw new UploadBodyError(chunk.byteLength > maximum ? 413 : 400, "Expected an empty upload");
      },
    }), { signal: request.signal });
    if (request.signal.aborted) throw new UploadBodyError(400, "Upload interrupted");
    return bucket.put(key, new Uint8Array(0), options);
  }
  const fixed = new FixedLengthStream(length);
  const abort = new AbortController();
  let bodyError: UploadBodyError | undefined;
  let received = 0;
  let finalByte: Uint8Array | undefined;
  const stop = () => {
    abort.abort();
    // A conditional PUT may finish without reading the stream. Release backpressure.
    void fixed.readable.cancel().catch(() => {});
  };
  const interrupted = () => {
    bodyError = new UploadBodyError(400, "Upload interrupted");
    stop();
  };
  request.signal.addEventListener("abort", interrupted, { once: true });
  if (request.signal.aborted) interrupted();
  const body = request.body || new ReadableStream({ start(controller) { controller.close(); } });
  const checked = body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > maximum || received > length) {
        bodyError = new UploadBodyError(received > maximum ? 413 : 400, "Upload size does not match the allowed length");
        throw bodyError;
      }
      // R2 knows the length. Withhold completion until EOF has been validated.
      if (received === length && chunk.byteLength) {
        finalByte = chunk.slice(-1);
        if (chunk.byteLength > 1) controller.enqueue(chunk.subarray(0, -1));
      } else if (chunk.byteLength) {
        controller.enqueue(chunk);
      }
    },
    flush(controller) {
      if (received !== length) {
        bodyError = new UploadBodyError(400, "Upload was truncated");
        throw bodyError;
      }
      if (finalByte) controller.enqueue(finalByte);
    },
  }), { signal: abort.signal });
  const pumping = checked.pipeTo(fixed.writable, { signal: abort.signal });
  const writing = Promise.resolve().then(() => bucket.put(key, fixed.readable, options));
  try {
    const object = await Promise.race([writing, pumping.then(() => writing)]);
    if (object === null) return null;
    await pumping;
    return object;
  } catch (error) {
    throw bodyError || error;
  } finally {
    request.signal.removeEventListener("abort", interrupted);
    // Never delete the key on failure: another upload may have won the race.
    stop();
  }
}

export async function onRequestPut(context) {
  const settings = publicUploadSettings(context.env);
  if (!settings.publicUploadEnabled) return response(503, { error: "Public uploads are disabled or misconfigured" });
  const request: Request = context.request;
  let name: string;
  try {
    const parts = context.params.name;
    if (Array.isArray(parts) && parts.length !== 1) throw new Error("Invalid name");
    name = decodeURIComponent(Array.isArray(parts) ? parts[0] : parts || "");
    if (!name || name === "." || name === ".." || /[/\\\u0000-\u001f\u007f-\u009f]/.test(name)
      || name.startsWith("_$") || name.includes("_$folder$")
      || new TextEncoder().encode(`public/${name}`).length > 1024) throw new Error("Invalid name");
  } catch {
    return response(400, { error: "Use a single valid filename in the public root" });
  }
  if (new URL(request.url).search || request.headers.has("x-amz-copy-source")
    || request.headers.has("fd-thumbnail")
    || [...request.headers.keys()].some((name) => name.startsWith("x-amz-meta-"))) {
    return response(400, { error: "Copy, metadata and multipart options are not allowed" });
  }
  const encoding = request.headers.get("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity") return response(415, { error: "Encoded request bodies are not supported" });
  const declared = request.headers.get("content-length");
  if (declared === null) return response(411, { error: "Content-Length is required" });
  if (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared))) return response(400, { error: "Invalid Content-Length" });
  const length = Number(declared);
  if (length > settings.maxPublicUploadBytes) return response(413, { error: "File exceeds the public upload limit" });
  if (request.signal.aborted) return response(400, { error: "Upload interrupted" });
  const [bucket] = parseBucketPath({ ...context, params: { path: [] } });
  if (!bucket) return response(503, { error: "Storage is unavailable" });
  try {
    const object = await createOnly(bucket, `public/${name}`, request, length, settings.maxPublicUploadBytes);
    if (object === null) return response(409, { error: "A file with this name already exists" });
    return response(201, { key: object.key, size: object.size, uploaded: object.uploaded });
  } catch (error) {
    return response(error instanceof UploadBodyError ? error.status : 500, {
      error: error instanceof UploadBodyError ? error.message : "Upload failed; existing files were not replaced",
    });
  }
}
