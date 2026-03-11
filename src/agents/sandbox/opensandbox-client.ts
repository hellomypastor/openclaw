export const OPEN_SANDBOX_HEALTH_PATH = "/health/ping";

export function normalizeOpenSandboxEndpointBase(endpoint: string) {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}

export function buildOpenSandboxLifecycleBaseUrl(endpoint: string) {
  return `${normalizeOpenSandboxEndpointBase(endpoint)}/v1`;
}

export function buildOpenSandboxHeaders(apiKey?: string, extra?: Record<string, string>) {
  return {
    accept: "application/json",
    ...(apiKey ? { "open-sandbox-api-key": apiKey } : {}),
    ...extra,
  };
}

export async function fetchOpenSandboxJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(body.trim() || `OpenSandbox request failed (${response.status}).`);
  }
  return (await response.json()) as T;
}

export async function fetchOpenSandbox(input: RequestInfo | URL, init?: RequestInit) {
  const response = await fetch(input, init);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(body.trim() || `OpenSandbox request failed (${response.status}).`);
  }
  return response;
}
