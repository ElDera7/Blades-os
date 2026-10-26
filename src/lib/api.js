export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(path, { method = "GET", body } = {}) {
  const write = method !== "GET";
  let res;
  // Never wait forever: a request that hangs (bad network, a stuck proxy) fails after 30 s like a dropped connection.
  // Sales carry a unique reference, so a retry after a timeout can't charge twice.
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl && setTimeout(() => ctl.abort(), 30000);
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers: write ? { "Content-Type": "application/json" } : {},
      body: write ? JSON.stringify(body ?? {}) : undefined,
      signal: ctl?.signal,
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.");
  } finally {
    if (timer) clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== "/auth/login") onUnauthorized();
    throw new ApiError(res.status, data.error || `Request failed (${res.status}).`);
  }
  return data;
}
