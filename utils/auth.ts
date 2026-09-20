const SESSION_COOKIE = "fd_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

function requestPath(context, override?: string) {
  const rawPath = override !== undefined
    ? override
    : Array.isArray(context.params?.path)
      ? context.params.path.join("/")
      : context.params?.path || "";

  try {
    const path = decodeURIComponent(rawPath).replace(/^\/+/, "");
    if (path.split("/").some((segment) => segment === "..")) return null;
    return path;
  } catch {
    return null;
  }
}

function allowedPath(path: string, permissions: string) {
  return permissions.split(",").some((allowed) =>
    allowed === "*" || (allowed !== "" && path.startsWith(allowed))
  );
}

function toBase64Url(value: string | ArrayBuffer) {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return atob(base64);
}

async function sign(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return toBase64Url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function cookies(request: Request) {
  return Object.fromEntries((request.headers.get("Cookie") || "").split(";").filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }));
}

export async function createSessionCookie(account: string, secret: string) {
  const payload = `${toBase64Url(account)}.${Date.now()}`;
  const signature = await sign(payload, secret);
  return `${SESSION_COOKIE}=${payload}.${signature}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

async function sessionAccount(context) {
  const value = cookies(context.request)[SESSION_COOKIE];
  if (!value || !context.env.SESSION_SECRET) return null;
  const parts = value.split(".");
  if (parts.length !== 3 || !/^\d+$/.test(parts[1])) return null;
  if (Date.now() - Number(parts[1]) > SESSION_MAX_AGE * 1000) return null;

  const payload = `${parts[0]}.${parts[1]}`;
  const expected = await sign(payload, context.env.SESSION_SECRET);
  if (expected !== parts[2]) return null;
  try { return fromBase64Url(parts[0]); } catch { return null; }
}

export async function get_auth_status(context, overridePath?: string, allowGuest = true) {
  const path = requestPath(context, overridePath);
  if (path === null) return false;
  if (allowGuest && context.env.GUEST && allowedPath(path, context.env.GUEST)) return true;

  const account = await sessionAccount(context);
  if (!account || !context.env[account]) return false;
  if (path.startsWith("_$flaredrive$/thumbnails/")) return true;
  return allowedPath(path, context.env[account]);
}

export async function authenticate(context, username: string, password: string) {
  const account = `${username}:${password}`;
  if (!username || !password || !context.env[account] || !context.env.SESSION_SECRET) return null;
  return createSessionCookie(account, context.env.SESSION_SECRET);
}

export function authFailure() {
  return new Response("Unauthorized", { status: 401 });
}
