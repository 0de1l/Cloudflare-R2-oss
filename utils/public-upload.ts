export const PUBLIC_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

export function publicUploadSettings(env) {
  const configured = env.PUBLIC_UPLOAD_MAX_BYTES;
  const value = configured === undefined ? PUBLIC_UPLOAD_MAX_BYTES
    : typeof configured === "string" && /^\d+$/.test(configured) ? Number(configured) : NaN;
  const valid = Number.isSafeInteger(value) && value > 0 && value <= PUBLIC_UPLOAD_MAX_BYTES;
  return {
    publicUploadEnabled: env.PUBLIC_UPLOAD_ENABLED === "true" && valid,
    maxPublicUploadBytes: valid ? value : 0,
  };
}
