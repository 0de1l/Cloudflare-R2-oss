import { authenticate } from "@/utils/auth";

export async function onRequestPost(context) {
  try {
    const { username, password } = await context.request.json();
    const cookie = await authenticate(context, username, password);
    if (!cookie) return new Response("Invalid credentials", { status: 401 });
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json", "Set-Cookie": cookie },
    });
  } catch {
    return new Response("Invalid request", { status: 400 });
  }
}
