import { authFailure, get_auth_status } from "@/utils/auth";
import { notFound, parseBucketPath } from "@/utils/bucket";

export async function onRequestPostCreateMultipart(context) {
  if (!get_auth_status(context)) return authFailure();
  const [bucket, path] = parseBucketPath(context);
  if (!bucket) return notFound();

  const request: Request = context.request;
  const customMetadata: Record<string, string> = {};
  if (request.headers.has("fd-thumbnail"))
    customMetadata.thumbnail = request.headers.get("fd-thumbnail");

  const multipartUpload = await bucket.createMultipartUpload(path, {
    httpMetadata: { contentType: request.headers.get("content-type") },
    customMetadata,
  });

  return new Response(
    JSON.stringify({ key: multipartUpload.key, uploadId: multipartUpload.uploadId })
  );
}

export async function onRequestPostCompleteMultipart(context) {
  if (!get_auth_status(context)) return authFailure();
  const [bucket, path] = parseBucketPath(context);
  if (!bucket) return notFound();

  const request: Request = context.request;
  const uploadId = new URL(request.url).searchParams.get("uploadId");
  const multipartUpload = await bucket.resumeMultipartUpload(path, uploadId);

  try {
    const completeBody: { parts: Array<any> } = await request.json();
    const object = await multipartUpload.complete(completeBody.parts);
    return new Response(null, { headers: { etag: object.httpEtag } });
  } catch (error: any) {
    return new Response(error.message, { status: 400 });
  }
}

export async function onRequestPost(context) {
  const searchParams = new URL(context.request.url).searchParams;
  if (searchParams.has("uploads")) return onRequestPostCreateMultipart(context);
  if (searchParams.has("uploadId")) return onRequestPostCompleteMultipart(context);
  return new Response("Method not allowed", { status: 405 });
}

export async function onRequestPutMultipart(context) {
  if (!get_auth_status(context)) return authFailure();
  const [bucket, path] = parseBucketPath(context);
  if (!bucket) return notFound();

  const request: Request = context.request;
  const url = new URL(request.url);
  const uploadId = url.searchParams.get("uploadId");
  const partNumber = parseInt(url.searchParams.get("partNumber"));
  const multipartUpload = await bucket.resumeMultipartUpload(path, uploadId);
  const uploadedPart = await multipartUpload.uploadPart(partNumber, request.body);

  return new Response(null, {
    headers: { "Content-Type": "application/json", etag: uploadedPart.etag },
  });
}

export async function onRequestPut(context) {
  if (!get_auth_status(context)) return authFailure();
  const url = new URL(context.request.url);
  if (url.searchParams.has("uploadId")) return onRequestPutMultipart(context);

  const [bucket, path] = parseBucketPath(context);
  if (!bucket) return notFound();

  const request: Request = context.request;
  let content = request.body;
  const customMetadata: Record<string, string> = {};

  if (request.headers.has("x-amz-copy-source")) {
    const sourceName = decodeURIComponent(request.headers.get("x-amz-copy-source"));
    if (!get_auth_status(context, sourceName)) return authFailure();
    const source = await bucket.get(sourceName);
    if (!source) return notFound();
    content = source.body;
    if (source.customMetadata.thumbnail)
      customMetadata.thumbnail = source.customMetadata.thumbnail;
  }

  if (request.headers.has("fd-thumbnail"))
    customMetadata.thumbnail = request.headers.get("fd-thumbnail");

  const obj = await bucket.put(path, content, { customMetadata });
  const { key, size, uploaded } = obj;
  return new Response(JSON.stringify({ key, size, uploaded }), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestDelete(context) {
  if (!get_auth_status(context)) return authFailure();
  const [bucket, path] = parseBucketPath(context);
  if (!bucket) return notFound();

  await bucket.delete(path);
  return new Response(null, { status: 204 });
}
