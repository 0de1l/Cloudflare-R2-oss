const SESSION_COOKIE = "fd_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;
const SESSION_MAX_LENGTH = 1024;

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

function accountEntries(context): [string, string][] {
  let accounts = context.env;
  if (context.env.AUTH_USERS !== undefined) {
    try {
      accounts = JSON.parse(context.env.AUTH_USERS);
    } catch {
      return [];
    }
  }

  // When AUTH_USERS is configured, it replaces legacy account bindings.
  if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) return [];
  return Object.entries(accounts).filter((entry): entry is [string, string] =>
    /^.+:.+$/s.test(entry[0]) && typeof entry[1] === "string" && entry[1] !== ""
  );
}

function accountPermissions(context, account: string): string | null {
  return accountEntries(context).find(([key]) => key === account)?.[1] ?? null;
}

function toBase64Url(value: string | ArrayBuffer | Uint8Array) {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid session encoding");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  if (toBase64Url(bytes) !== value) throw new Error("Noncanonical session encoding");
  return bytes;
}

function sessionKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function accountMessage(account: string) {
  // Separate account identifiers from session signatures even though they share a key.
  return JSON.stringify(["account-id-v2", account]);
}

async function sign(value: string, key: CryptoKey) {
  return toBase64Url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function cookies(request: Request) {
  return Object.fromEntries((request.headers.get("Cookie") || "").split(";").filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }));
}

export async function createSessionCookie(account: string, secret: string) {
  const key = await sessionKey(secret);
  const iat = Math.floor(Date.now() / 1000);
  const encoded = toBase64Url(JSON.stringify({
    sub: await sign(accountMessage(account), key),
    iat,
    exp: iat + SESSION_MAX_AGE,
    nonce: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
  }));
  const payload = `v2.${encoded}`;
  const signature = await sign(`session-v2:${payload}`, key);
  return `${SESSION_COOKIE}=${payload}.${signature}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

async function sessionAccount(context) {
  const value = cookies(context.request)[SESSION_COOKIE];
  const secret = context.env.SESSION_SECRET;
  if (!value || value.length > SESSION_MAX_LENGTH || typeof secret !== "string" || !secret) return null;
  const parts = value.split(".");
  // Never decode or upgrade the old credential-bearing cookie format.
  if (parts.length !== 3 || parts[0] !== "v2") return null;
  try {
    const signature = fromBase64Url(parts[2]);
    if (signature.length !== 32) return null;
    const key = await sessionKey(secret);
    if (!(await crypto.subtle.verify(
      "HMAC", key, signature, new TextEncoder().encode(`session-v2:${parts[0]}.${parts[1]}`)
    ))) return null;

    const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(parts[1])));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || Object.keys(payload).sort().join(",") !== "exp,iat,nonce,sub") return null;
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
      || payload.iat < 0 || payload.iat > now || payload.exp <= now
      || payload.exp <= payload.iat || payload.exp - payload.iat > SESSION_MAX_AGE) return null;
    if (typeof payload.sub !== "string" || typeof payload.nonce !== "string") return null;
    const subject = fromBase64Url(payload.sub);
    if (subject.length !== 32 || fromBase64Url(payload.nonce).length !== 16) return null;

    for (const [account] of accountEntries(context)) {
      if (await crypto.subtle.verify("HMAC", key, subject, new TextEncoder().encode(accountMessage(account)))) {
        return account;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function pathAuthStatus(context, path: string | null, write = false) {
  if (path === null) return false;

  const account = await sessionAccount(context);
  if (!account) return false;
  const permissions = accountPermissions(context, account);
  if (!permissions) return false;
  if (write && (path === "public" || path.startsWith("public/"))) {
    return permissions.split(",").includes("*");
  }
  if (path.startsWith("_$flaredrive$/thumbnails/")) return true;
  return allowedPath(path, permissions);
}

export async function get_auth_status(context, overridePath?: string, _allowGuest = true) {
  return pathAuthStatus(context, requestPath(context, overridePath));
}

export async function get_write_auth_status(context, overridePath?: string) {
  return pathAuthStatus(context, requestPath(context, overridePath), true);
}

export function is_public_directory(context) {
  const path = requestPath(context);
  return path !== null && (path === "public" || path.startsWith("public/"));
}

export function is_public_file(context) {
  const path = requestPath(context);
  return path !== null && path.startsWith("public/");
}

export async function get_session_info(context) {
  const account = await sessionAccount(context);
  if (!account) return { authenticated: false, home: "public/", publicRoot: "public/" };

  const permissions = accountPermissions(context, account);
  if (!permissions) return { authenticated: false, home: "public/", publicRoot: "public/" };
  const home = permissions.split(",").includes("*")
    ? ""
    : permissions.split(",").find((path) => path !== "")?.replace(/\/*$/, "/") || "";
  return { authenticated: true, home, publicRoot: "public/" };
}

export async function authenticate(context, username: string, password: string) {
  if (typeof username !== "string" || typeof password !== "string" || !username || !password) return null;
  const account = `${username}:${password}`;
  if (!accountPermissions(context, account)
    || typeof context.env.SESSION_SECRET !== "string" || !context.env.SESSION_SECRET) return null;
  return createSessionCookie(account, context.env.SESSION_SECRET);
}

export function authFailure() {
  return new Response("Unauthorized", { status: 401 });
}
