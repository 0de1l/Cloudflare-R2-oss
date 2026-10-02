import { authFailure, get_auth_status, is_public_file } from "@/utils/auth";
import { notFound, parseBucketPath } from "@/utils/bucket";

export async function onRequestGet(context) {
  if (!is_public_file(context) && !(await get_auth_status(context, undefined, false))) return authFailure();
  const [bucket, path] = parseBucketPath(context);
  if (!bucket) return notFound();

  const object = await bucket.get(path);
  if (!object) return notFound();

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", "no-store");

  return new Response(object.body, { headers });
}

export async function onRequestHead(context) {
  if (!is_public_file(context) && !(await get_auth_status(context, undefined, false))) return authFailure();
  const [bucket, path] = parseBucketPath(context);
  if (!bucket) return notFound();

  const object = await bucket.head(path);
  if (!object) return notFound();

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", "no-store");
  return new Response(null, { headers });
}
