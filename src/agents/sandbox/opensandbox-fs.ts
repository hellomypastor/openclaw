import {
  buildOpenSandboxHeaders,
  fetchOpenSandbox,
  fetchOpenSandboxJson,
} from "./opensandbox-client.js";

type OpenSandboxExecdRequestParams = {
  execdBaseUrl: string;
  apiKey?: string;
  signal?: AbortSignal;
};

function buildExecdUrl(execdBaseUrl: string, pathname: string) {
  return new URL(pathname, `${execdBaseUrl.replace(/\/+$/, "")}/`);
}

function buildJsonRequestInit(params: OpenSandboxExecdRequestParams, body?: string): RequestInit {
  return {
    headers: buildOpenSandboxHeaders(params.apiKey, { "content-type": "application/json" }),
    body,
    signal: params.signal,
  };
}

export async function readOpenSandboxFile(params: {
  execdBaseUrl: string;
  apiKey?: string;
  filePath: string;
  signal?: AbortSignal;
}) {
  const url = buildExecdUrl(params.execdBaseUrl, "files/download");
  url.searchParams.set("path", params.filePath);
  const response = await fetchOpenSandbox(url, {
    method: "GET",
    headers: buildOpenSandboxHeaders(params.apiKey),
    signal: params.signal,
  });
  return Buffer.from(await response.arrayBuffer());
}

export async function writeOpenSandboxFile(params: {
  execdBaseUrl: string;
  apiKey?: string;
  filePath: string;
  data: Buffer;
  signal?: AbortSignal;
}) {
  const form = new FormData();
  form.append(
    "metadata",
    new Blob([JSON.stringify({ path: params.filePath })], {
      type: "application/json",
    }),
    "metadata",
  );
  form.append("file", new Blob([new Uint8Array(params.data)]), "file");
  await fetchOpenSandbox(buildExecdUrl(params.execdBaseUrl, "files/upload"), {
    method: "POST",
    headers: params.apiKey ? { "open-sandbox-api-key": params.apiKey } : undefined,
    body: form,
    signal: params.signal,
  });
}

export async function getOpenSandboxFileInfo(params: {
  execdBaseUrl: string;
  apiKey?: string;
  filePath: string;
  signal?: AbortSignal;
}) {
  const url = buildExecdUrl(params.execdBaseUrl, "files/info");
  url.searchParams.append("path", params.filePath);
  return await fetchOpenSandboxJson<
    Record<string, { size?: number; modifiedAt?: string; mode?: number }>
  >(url, {
    method: "GET",
    headers: buildOpenSandboxHeaders(params.apiKey),
    signal: params.signal,
  });
}

export async function createOpenSandboxDirectories(params: {
  execdBaseUrl: string;
  apiKey?: string;
  filePath: string;
  signal?: AbortSignal;
}) {
  await fetchOpenSandbox(buildExecdUrl(params.execdBaseUrl, "directories"), {
    method: "POST",
    ...buildJsonRequestInit(
      params,
      JSON.stringify({
        [params.filePath]: {
          mode: 0,
        },
      }),
    ),
  });
}

export async function deleteOpenSandboxFiles(params: {
  execdBaseUrl: string;
  apiKey?: string;
  filePath: string;
  signal?: AbortSignal;
}) {
  const url = buildExecdUrl(params.execdBaseUrl, "files");
  url.searchParams.append("path", params.filePath);
  await fetchOpenSandbox(url, {
    method: "DELETE",
    headers: buildOpenSandboxHeaders(params.apiKey),
    signal: params.signal,
  });
}

export async function deleteOpenSandboxDirectories(params: {
  execdBaseUrl: string;
  apiKey?: string;
  filePath: string;
  signal?: AbortSignal;
}) {
  const url = buildExecdUrl(params.execdBaseUrl, "directories");
  url.searchParams.append("path", params.filePath);
  await fetchOpenSandbox(url, {
    method: "DELETE",
    headers: buildOpenSandboxHeaders(params.apiKey),
    signal: params.signal,
  });
}

export async function moveOpenSandboxFile(params: {
  execdBaseUrl: string;
  apiKey?: string;
  from: string;
  to: string;
  signal?: AbortSignal;
}) {
  await fetchOpenSandbox(buildExecdUrl(params.execdBaseUrl, "files/mv"), {
    method: "POST",
    ...buildJsonRequestInit(params, JSON.stringify([{ src: params.from, dest: params.to }])),
  });
}
