import { get_session_info, get_auth_status } from "@/utils/auth";
import { publicUploadSettings } from "@/utils/public-upload";

export async function onRequestGet(context) {
  return new Response(JSON.stringify({
    ...await get_session_info(context),
    ...publicUploadSettings(context.env),
    canManagePublic: await get_auth_status(context, "*", false),
  }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
