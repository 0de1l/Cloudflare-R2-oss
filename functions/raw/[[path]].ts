import { authFailure, get_auth_status } from "@/utils/auth";
import { notFound, parseBucketPath } from "@/utils/bucket";

export async function onRequestGet(context) {
  const [bucket, path] = parseBucketPath(context);
  if (!bucket) return notFound();
  if (!(await get_auth_status(context, undefined, false))) return authFailure();

  const object = await bucket.get(path);
  if (!object) return notFound();

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set(
    "Cache-Control",
    path.startsWith("_$flaredrive$/thumbnails/")
      ? "private, max-age=31536000"
      : "private, no-store"
  );

  return new Response(object.body, { headers });
}
