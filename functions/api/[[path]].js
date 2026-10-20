import { handleApi } from "../_lib/upstream.js";

export async function onRequest(context) {
  try {
    return await handleApi(context.request);
  } catch {
    return new Response("Proxy failed.", {
      status: 500,
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
