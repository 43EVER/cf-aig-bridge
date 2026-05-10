#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const baseUrl = stripTrailingSlash(process.env.BASE_URL ?? "https://cf-aig-bridge.i-807.workers.dev");
const outDir = process.env.OUT_DIR ?? ".live-results";
const gatewayId = process.env.AI_GATEWAY_ID ?? "aifuckclaude";
const bridgeApiKey = process.env.BRIDGE_API_KEY ?? "";
const curlProxy =
  process.env.CURL_PROXY ??
  process.env.HTTPS_PROXY ??
  process.env.https_proxy ??
  process.env.ALL_PROXY ??
  process.env.all_proxy ??
  "";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CF_ACCOUNT_ID ?? "";
const cloudflareApiToken = process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN ?? "";

await mkdir(outDir, { recursive: true });

const startedAt = new Date().toISOString();
const results = [];

await runCase({
  name: "healthz",
  method: "GET",
  path: "/healthz"
});

await runCase({
  name: "models",
  method: "GET",
  path: "/v1/models"
});

await runCase({
  name: "validation-stream-true",
  method: "POST",
  path: "/v1/images/generations",
  expectedStatus: 400,
  body: {
    model: "gpt-image-2",
    prompt: "this request should be rejected before upstream",
    stream: true
  }
});

await runCase({
  name: "validation-bad-size",
  method: "POST",
  path: "/v1/images/generations",
  expectedStatus: 400,
  body: {
    model: "gpt-image-2",
    prompt: "this request should be rejected before upstream",
    size: "1792x1024"
  }
});

await runCase({
  name: "validation-bad-output-format",
  method: "POST",
  path: "/v1/images/generations",
  expectedStatus: 400,
  body: {
    model: "gpt-image-2",
    prompt: "this request should be rejected before upstream",
    output_format: "gif"
  }
});

await runCase({
  name: "validation-bad-input-fidelity",
  method: "POST",
  path: "/v1/images/edits",
  expectedStatus: 400,
  body: {
    model: "gpt-image-2",
    prompt: "this request should be rejected before upstream",
    image: "data:image/png;base64,aW1n",
    input_fidelity: "standard"
  }
});

await runCase({
  name: "validation-mask-rejected",
  method: "POST",
  path: "/v1/images/edits",
  expectedStatus: 400,
  body: {
    model: "gpt-image-2",
    prompt: "this request should be rejected before upstream",
    image: "data:image/png;base64,aW1n",
    mask: "data:image/png;base64,bWFzaw=="
  }
});

const generatedUrlResults = [];

for (const generationCase of [
  {
    name: "gen-low-square-png-url",
    ext: "png",
    body: {
      model: "gpt-image-2",
      prompt: "A small red cube centered on a plain white tabletop, crisp product photo",
      quality: "low",
      size: "1024x1024",
      background: "opaque",
      output_format: "png",
      response_format: "url"
    }
  },
  {
    name: "gen-medium-portrait-webp-url",
    ext: "webp",
    body: {
      model: "gpt-image-2",
      prompt: "A vertical poster of a quiet glass greenhouse at dawn, clean editorial style",
      quality: "medium",
      size: "1024x1536",
      background: "auto",
      output_format: "webp",
      moderation: "auto",
      user: "live-smoke",
      response_format: "url"
    }
  },
  {
    name: "gen-high-landscape-jpeg-url",
    ext: "jpg",
    body: {
      model: "gpt-image-2",
      prompt: "A wide landscape product scene with a matte black notebook beside a ceramic mug",
      quality: "high",
      size: "1536x1024",
      output_format: "jpeg",
      output_compression: 82,
      response_format: "url"
    }
  },
  {
    name: "gen-auto-b64-json",
    ext: "png",
    body: {
      model: "gpt-image-2",
      prompt: "A minimal blue origami boat on a neutral background",
      quality: "auto",
      size: "auto",
      output_format: "png",
      partial_images: 0,
      response_format: "b64_json"
    }
  }
]) {
  const result = await runCase({
    name: generationCase.name,
    method: "POST",
    path: "/v1/images/generations",
    body: generationCase.body,
    ext: generationCase.ext,
    timeoutSeconds: 420
  });

  if (isCloudflarePaymentError(result)) {
    results.push({
      name: "remaining-image-cases-skipped-after-payment-error",
      ok: false,
      expected_status: 200,
      status: 0,
      time_ms: 0,
      error: "Cloudflare returned Payment error for the image model; skipped remaining paid image requests"
    });
    break;
  }

  const url = firstImageUrl(result.body);
  if (url) {
    generatedUrlResults.push({ ...generationCase, url });
    await downloadImage(generationCase.name, url, generationCase.ext);
  }
}

const editInputUrl = generatedUrlResults[0]?.url;
if (editInputUrl) {
  await runCase({
    name: "edit-from-generated-url",
    method: "POST",
    path: "/v1/images/edits",
    body: {
      model: "gpt-image-2",
      prompt: "Keep the same cube, but recolor it blue and add a thin green outline",
      images: [{ image_url: editInputUrl }],
      quality: "low",
      size: "1024x1024",
      output_format: "png",
      input_fidelity: "high",
      response_format: "url"
    },
    ext: "png",
    timeoutSeconds: 420
  });

  await runCase({
    name: "variation-from-generated-url",
    method: "POST",
    path: "/v1/images/variations",
    body: {
      model: "gpt-image-2",
      image: { image_url: editInputUrl },
      n: 1,
      quality: "low",
      size: "1024x1024",
      response_format: "url"
    },
    ext: "png",
    timeoutSeconds: 420
  });
} else {
  results.push({
    name: "edit-and-variation-skipped",
    ok: false,
    expected_status: 200,
    status: 0,
    time_ms: 0,
    error: "No generation URL was available for edit/variation inputs"
  });
}

const cloudflareLogs = await readCloudflareGatewayLogs();
const finishedAt = new Date().toISOString();

const report = {
  base_url: baseUrl,
  gateway_id: gatewayId,
  started_at: startedAt,
  finished_at: finishedAt,
  results,
  cloudflare_logs: cloudflareLogs
};

const reportPath = `${outDir}/live-images-smoke-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(JSON.stringify(report, null, 2));
console.error(`Report written to ${reportPath}`);

if (results.some((result) => !result.ok)) {
  process.exitCode = 1;
}

async function runCase({ name, method, path, expectedStatus = 200, body, ext = "png", timeoutSeconds = 240 }) {
  const started = performance.now();
  const response = await curlJson({ method, path, body, timeoutSeconds });
  const elapsed = Math.round(performance.now() - started);
  const sanitized = sanitizeBody(response.body);
  const b64Artifact = await persistFirstBase64Image(name, response.body, ext);
  const urlArtifact = await persistFirstUrlImage(name, response.body, ext);
  const result = {
    name,
    ok: response.status === expectedStatus,
    expected_status: expectedStatus,
    status: response.status,
    time_ms: response.timeMs || elapsed,
    curl_time_ms: response.timeMs,
    body: sanitized,
    artifacts: [...b64Artifact, ...urlArtifact],
    error: response.error
  };
  results.push(result);
  return { ...result, body: response.body };
}

async function curlJson({ method, path, body, timeoutSeconds }) {
  const args = commonCurlArgs(timeoutSeconds);
  args.push("-X", method, `${baseUrl}${path}`, "-H", "accept: application/json");
  if (bridgeApiKey) {
    args.push("-H", `authorization: Bearer ${bridgeApiKey}`);
  }
  if (body !== undefined) {
    args.push("-H", "content-type: application/json", "--data-binary", JSON.stringify(body));
  }
  args.push("-w", "\n__CF_AIG_BRIDGE_META__%{http_code} %{time_total}\n");

  try {
    const { stdout, stderr } = await execFileAsync("curl", args, {
      encoding: "utf8",
      maxBuffer: 80 * 1024 * 1024,
      timeout: (timeoutSeconds + 10) * 1000
    });
    return parseCurlJson(stdout, stderr);
  } catch (error) {
    return {
      status: 0,
      timeMs: 0,
      body: null,
      error: redactSecret(error instanceof Error ? error.message : String(error))
    };
  }
}

async function downloadImage(name, url, ext) {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return [];
  }

  const path = `${outDir}/${name}.${ext}`;
  const args = commonCurlArgs(180);
  args.push("-L", url, "-o", path);
  try {
    await execFileAsync("curl", args, {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: 190_000
    });
    return [path];
  } catch {
    return [];
  }
}

async function persistFirstUrlImage(name, body, ext) {
  const url = firstImageUrl(body);
  if (!url) {
    return [];
  }
  return await downloadImage(name, url, ext);
}

async function persistFirstBase64Image(name, body, ext) {
  const b64 = body?.data?.find?.((item) => typeof item?.b64_json === "string")?.b64_json;
  if (!b64) {
    return [];
  }

  const path = `${outDir}/${name}.${ext}`;
  await writeFile(path, Buffer.from(b64, "base64"));
  return [path];
}

function parseCurlJson(stdout, stderr) {
  const marker = "\n__CF_AIG_BRIDGE_META__";
  const markerIndex = stdout.lastIndexOf(marker);
  if (markerIndex === -1) {
    return {
      status: 0,
      timeMs: 0,
      body: null,
      error: stderr || "curl response did not include status metadata"
    };
  }

  const bodyText = stdout.slice(0, markerIndex);
  const [statusText, timeText] = stdout.slice(markerIndex + marker.length).trim().split(/\s+/);
  let parsedBody = null;
  try {
    parsedBody = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    parsedBody = { raw: bodyText.slice(0, 2000) };
  }

  return {
    status: Number(statusText),
    timeMs: Math.round(Number(timeText) * 1000),
    body: parsedBody,
    error: stderr ? redactSecret(stderr) : undefined
  };
}

function commonCurlArgs(timeoutSeconds) {
  const args = ["-sS", "--max-time", String(timeoutSeconds)];
  if (curlProxy) {
    args.push("-x", curlProxy);
  }
  return args;
}

function sanitizeBody(body) {
  if (!body || typeof body !== "object") {
    return body;
  }

  if (Array.isArray(body.data) && body.data.some(isImageDataItem)) {
    return {
      ...body,
      data: body.data.map((item) => ({
        url: typeof item.url === "string" ? item.url : undefined,
        b64_json_bytes: typeof item.b64_json === "string" ? Buffer.byteLength(item.b64_json, "base64") : undefined,
        revised_prompt: item.revised_prompt
      }))
    };
  }

  return body;
}

function isImageDataItem(item) {
  return Boolean(
    item &&
      typeof item === "object" &&
      ("url" in item || "b64_json" in item || "revised_prompt" in item)
  );
}

function isCloudflarePaymentError(result) {
  return JSON.stringify(result.body ?? result.error ?? "").includes("Payment error");
}

function firstImageUrl(body) {
  return body?.data?.find?.((item) => typeof item?.url === "string")?.url;
}

async function readCloudflareGatewayLogs() {
  if (!accountId || !cloudflareApiToken) {
    return {
      ok: false,
      skipped: true,
      reason: "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to query AI Gateway logs"
    };
  }

  const args = commonCurlArgs(60);
  const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/logs?per_page=20`;
  args.push(apiUrl, "-H", "accept: application/json", "-H", `authorization: Bearer ${cloudflareApiToken}`);
  args.push("-w", "\n__CF_AIG_BRIDGE_META__%{http_code} %{time_total}\n");

  try {
    const { stdout, stderr } = await execFileAsync("curl", args, {
      encoding: "utf8",
      maxBuffer: 40 * 1024 * 1024,
      timeout: 70_000
    });
    const response = parseCurlJson(stdout, stderr);
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      time_ms: response.timeMs,
      logs: summarizeGatewayLogs(response.body),
      error: response.status >= 200 && response.status < 300 ? undefined : sanitizeBody(response.body)
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: redactSecret(error instanceof Error ? error.message : String(error))
    };
  }
}

function summarizeGatewayLogs(body) {
  const items = Array.isArray(body?.result) ? body.result : Array.isArray(body) ? body : [];
  return items.slice(0, 20).map((item) => pickLogFields(item));
}

function pickLogFields(item) {
  const summary = {};
  for (const key of [
    "id",
    "created_at",
    "createdAt",
    "provider",
    "model",
    "status_code",
    "statusCode",
    "success",
    "duration",
    "duration_ms",
    "durationMs",
    "cost",
    "price",
    "request_id",
    "requestId"
  ]) {
    if (item?.[key] !== undefined) {
      summary[key] = item[key];
    }
  }

  const nestedCost = findDeepNumberField(item, /cost|price|amount/i);
  if (nestedCost !== undefined && summary.cost === undefined && summary.price === undefined) {
    summary.detected_cost_or_price = nestedCost;
  }

  return summary;
}

function findDeepNumberField(value, pattern, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return undefined;
  }
  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    if (pattern.test(key) && typeof nested === "number") {
      return nested;
    }
    const found = findDeepNumberField(nested, pattern, seen);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function redactSecret(value) {
  let redacted = value;
  for (const secret of [bridgeApiKey, cloudflareApiToken]) {
    if (secret) {
      redacted = redacted.split(secret).join("<redacted>");
    }
  }
  return redacted;
}
