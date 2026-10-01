// Narrow credential-bearing transport shared with the canonical Worker. No
// redirect, unbounded body, implicit retry, arbitrary endpoint or raw-error log.
const endpoints: Record<string, string> = {
  "https://api.x.com/2/oauth2/token": "POST",
  "https://api.x.com/2/users/me": "GET",
  "https://api.linkedin.com/v2/userinfo": "GET",
  "https://graph.threads.net/v1.0/me?fields=id": "GET",
};
export async function connectionJson(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  if (endpoints[url] !== (init.method || "GET")) throw Error("connection_endpoint_rejected");
  if (init.signal?.aborted) throw Error("connection_request_cancelled");
  const controller = new AbortController();
  let stop: (error: Error) => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    stop = reject;
  });
  const cancel = () => {
    controller.abort();
    stop(Error("connection_request_unverified"));
  };
  const timer = setTimeout(cancel, 10000);
  init.signal?.addEventListener("abort", cancel, { once: true });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (init.signal?.aborted) throw Error("connection_request_cancelled");
    const r = await Promise.race([
      fetchImpl(url, { ...init, redirect: "manual", signal: controller.signal }),
      stopped,
    ]);
    if (r.status < 200 || r.status >= 300 || !r.body) {
      void r.body?.cancel().catch(() => {});
      throw Error("connection_request_unverified");
    }
    reader = r.body.getReader();
    let size = 0,
      text = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (;;) {
      const next = await Promise.race([reader.read(), stopped]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 65536) throw Error("connection_response_unverified");
      text += decoder.decode(next.value, { stream: true });
    }
    if (controller.signal.aborted) throw Error("connection_request_unverified");
    const value: unknown = JSON.parse(text + decoder.decode());
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error("connection_response_unverified");
    return value as Record<string, unknown>;
  } catch {
    // No provider body, token-bearing URL, secret or private exception escapes.
    throw Error(
      "Connection verification failed. Reconnect with the correct account and permissions.",
    );
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", cancel);
    controller.abort();
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
