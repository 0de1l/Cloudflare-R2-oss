const INLINE_CONTENT_TYPES = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["avif", "image/avif"],
  ["bmp", "image/bmp"],
  ["mp3", "audio/mpeg"],
  ["wav", "audio/wav"],
  ["ogg", "audio/ogg"],
  ["oga", "audio/ogg"],
  ["opus", "audio/ogg"],
  ["m4a", "audio/mp4"],
  ["aac", "audio/aac"],
  ["flac", "audio/flac"],
  ["mp4", "video/mp4"],
  ["m4v", "video/mp4"],
  ["webm", "video/webm"],
  ["ogv", "video/ogg"],
  ["mov", "video/quicktime"],
  ["txt", "text/plain; charset=utf-8"],
]);

export function publicContentHeaders(key: string) {
  const filename = key.split("/").pop() || "download";
  const extension = filename.includes(".") ? filename.split(".").pop().toLowerCase() : "";
  const inlineType = INLINE_CONTENT_TYPES.get(extension);
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );

  // Public object metadata is untrusted, including metadata on pre-existing files.
  return new Headers({
    "Content-Type": inlineType || "application/octet-stream",
    "Content-Disposition": `${inlineType ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encoded}`,
    "Content-Security-Policy": "sandbox; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
}
