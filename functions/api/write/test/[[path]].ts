import { authFailure, get_auth_status } from "@/utils/auth";

export async function onRequest(context) {
  if (!get_auth_status(context)) return authFailure();
  return new Response("access", { status: 200 });
}
