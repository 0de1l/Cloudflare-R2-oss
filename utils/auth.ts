function requestPath(context, override?: string) {
  if (override !== undefined) {
    try {
      const path = decodeURIComponent(override).replace(/^\/+/, "");
      if (path.split("/").some((segment) => segment === "..")) return null;
      return path;
    } catch {
      return null;
    }
  }

  const rawPath = context.params?.path;
  const joined = Array.isArray(rawPath) ? rawPath.join("/") : rawPath || "";

  try {
    const path = decodeURIComponent(joined).replace(/^\/+/, "");
    if (path.split("/").some((segment) => segment === "..")) return null;
    return path;
  } catch {
    return null;
  }
}

function allowedPath(path: string, permissions: string) {
  return permissions.split(",").some((allowed) => {
    if (allowed === "*") return true;
    return allowed !== "" && path.startsWith(allowed);
  });
}

// Guests are only considered for write operations. Reads always require an account.
export function get_auth_status(
  context,
  overridePath?: string,
  allowGuest = true
) {
  const path = requestPath(context, overridePath);
  if (path === null) return false;

  if (
    allowGuest &&
    context.env["GUEST"] &&
    allowedPath(path, context.env["GUEST"])
  ) {
    return true;
  }

  const authorization = context.request.headers.get("Authorization");
  if (!authorization || !authorization.startsWith("Basic ")) return false;

  let account: string;
  try {
    account = atob(authorization.slice("Basic ".length));
  } catch {
    return false;
  }

  const permissions = context.env[account];
  if (!permissions) return false;
  if (path.startsWith("_$flaredrive$/thumbnails/")) return true;
  return allowedPath(path, permissions);
}

export function authFailure() {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="需要登录"' },
  });
}
