import type { Account, Session } from "../shared/types.js";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
      credentials: "same-origin",
    });
  } catch {
    // fetch throws TypeError on network failure
    throw new HttpError(0, "NETWORK", "Cannot reach the ATM server.");
  }

  if (!res.ok) {
    let code = `HTTP_${res.status}`;
    let message = res.statusText;
    try {
      const body = await res.json();
      code = body.error?.code || code;
      message = body.error?.message || message;
    } catch {
      // non-JSON error body; keep the defaults above
    }
    throw new HttpError(res.status, code, message);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}

// The server wraps payloads: { session: {...} } and { account: {...} }.
// Every caller gets the unwrapped object.
export async function login(name: string): Promise<Session> {
  const body = await request<{ session: Session }>("/api/session", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  return body.session;
}

export async function nameAvailable(name: string): Promise<boolean> {
  const res = await request<{ available: boolean }>(`/api/session/availability?name=${encodeURIComponent(name)}`);
  return res.available;
}

export async function currentSession(): Promise<Session | null> {
  try {
    const body = await request<{ session: Session }>("/api/session");
    return body.session;
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) {
      return null;
    }
    throw e;
  }
}

export async function logout(): Promise<void> {
  await request("/api/session", { method: "DELETE" });
}

export async function getAccount(): Promise<Account> {
  const body = await request<{ account: Account }>("/api/account");
  return body.account;
}

// Slice 05 replaces this with a WebSocket re-handshake so the socket picks up
// the new/cleared cookie. No-op in this slice.
export async function refreshSession(): Promise<void> {}
