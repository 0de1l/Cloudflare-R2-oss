import { get_session_info } from "@/utils/auth";

export async function onRequestGet(context) {
  return new Response(JSON.stringify(await get_session_info(context)), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
