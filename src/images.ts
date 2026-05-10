import { HttpError } from "./errors";
import type {
  CloudflareAiImageResult,
  Env,
  OpenAIImageData,
  OpenAIImageGenerationRequest,
  OpenAIImagesResponse,
  OpenAIImagesResponseMetadata
} from "./types";

const OPENAI_IMAGE_PATH = "/v1/images/generations";
const CLOUDFLARE_OPENAI_MODEL_PREFIX = "openai/";
const SUPPORTED_RESPONSE_FORMATS = new Set(["b64_json", "url"]);
const SUPPORTED_BACKGROUND_VALUES = new Set(["transparent", "opaque", "auto"]);
const SUPPORTED_MODERATION_VALUES = new Set(["low", "auto"]);
const SUPPORTED_OUTPUT_FORMAT_VALUES = new Set(["png", "webp", "jpeg"]);
const SUPPORTED_QUALITY_VALUES = new Set(["low", "medium", "high", "auto"]);
const SUPPORTED_SIZE_VALUES = new Set(["1024x1024", "1024x1536", "1536x1024", "auto"]);

export function isImagesGenerationsPath(pathname: string): boolean {
  return pathname === OPENAI_IMAGE_PATH || pathname === "/images/generations";
}

export async function handleImageGeneration(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    throw new HttpError(405, "Method not allowed", "invalid_request_error");
  }

  const body = await readJson<OpenAIImageGenerationRequest>(request);
  rejectUnsupportedStreaming(body.stream);
  validateClientOnlyParams(body);
  const prompt = readRequiredString(body.prompt, "prompt");
  const n = readOptionalIntegerInRange(body.n, "n", 1, 1, 10);
  const responseFormat = readResponseFormat(body.response_format);
  const requestedModel = readOptionalString(body.model, "model") ?? env.DEFAULT_IMAGE_MODEL ?? "gpt-image-2";
  const cloudflareModel = toCloudflareOpenAIModel(requestedModel, env.PUBLIC_MODEL_PREFIX ?? "");

  const data: OpenAIImageData[] = [];
  let metadata: OpenAIImagesResponseMetadata = {};
  for (let index = 0; index < n; index += 1) {
    const cfResult = await runCloudflareImageModel(env, cloudflareModel, buildCloudflareInput(body, prompt));
    const firstImage = extractFirstImage(cfResult);
    metadata = { ...metadata, ...extractResponseMetadata(cfResult) };

    if (!firstImage) {
      throw new HttpError(502, "Cloudflare AI Gateway image response did not contain an image", "upstream_error");
    }

    const item = extractFirstImageData(cfResult);
    const revisedPrompt = item?.revised_prompt;
    if (responseFormat === "url") {
      data.push(withRevisedPrompt({ url: await imageToUrl(firstImage) }, revisedPrompt));
    } else {
      data.push(withRevisedPrompt({ b64_json: await imageToBase64(firstImage) }, revisedPrompt));
    }
  }

  const response: OpenAIImagesResponse = {
    created: Math.floor(Date.now() / 1000),
    ...metadata,
    data
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

async function readJson<T>(request: Request): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType && !contentType.toLowerCase().includes("application/json")) {
    throw new HttpError(400, "Expected application/json request body", "invalid_request_error");
  }

  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON request body", "invalid_request_error");
  }
}

function readRequiredString(value: unknown, param: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `Missing required parameter: ${param}`, "invalid_request_error", param);
  }

  return value;
}

function readOptionalString(value: unknown, param: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `Invalid parameter: ${param} must be a string`, "invalid_request_error", param);
  }

  return value;
}

function readOptionalIntegerInRange(
  value: unknown,
  param: string,
  defaultValue: number,
  min: number,
  max: number
): number {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(
      400,
      `Invalid parameter: ${param} must be an integer between ${min} and ${max}`,
      "invalid_request_error",
      param
    );
  }

  return value;
}

function rejectUnsupportedStreaming(value: unknown): void {
  if (value === undefined || value === null || value === false) {
    return;
  }

  if (value === true) {
    throw new HttpError(400, "Streaming image generation is not supported by this bridge", "invalid_request_error", "stream");
  }

  throw new HttpError(400, "Invalid parameter: stream must be a boolean", "invalid_request_error", "stream");
}

function readResponseFormat(value: unknown): "b64_json" | "url" {
  if (value === undefined || value === null) {
    return "b64_json";
  }

  if (typeof value !== "string" || !SUPPORTED_RESPONSE_FORMATS.has(value)) {
    throw new HttpError(
      400,
      "Invalid parameter: response_format must be one of b64_json or url",
      "invalid_request_error",
      "response_format"
    );
  }

  return value as "b64_json" | "url";
}

export function toCloudflareOpenAIModel(model: string, publicModelPrefix: string): string {
  const normalizedPrefix = publicModelPrefix.trim();
  let normalizedModel = model.trim();

  if (normalizedPrefix && normalizedModel.startsWith(normalizedPrefix)) {
    normalizedModel = normalizedModel.slice(normalizedPrefix.length);
  }

  if (normalizedModel.startsWith(CLOUDFLARE_OPENAI_MODEL_PREFIX)) {
    return normalizedModel;
  }

  return `${CLOUDFLARE_OPENAI_MODEL_PREFIX}${normalizedModel}`;
}

function buildCloudflareInput(body: OpenAIImageGenerationRequest, prompt: string): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt };
  copyStringEnumParam(body, input, "size", SUPPORTED_SIZE_VALUES);
  copyStringEnumParam(body, input, "quality", SUPPORTED_QUALITY_VALUES);
  copyStringEnumParam(body, input, "background", SUPPORTED_BACKGROUND_VALUES);
  copyStringEnumParam(body, input, "output_format", SUPPORTED_OUTPUT_FORMAT_VALUES);
  return input;
}

function validateClientOnlyParams(body: OpenAIImageGenerationRequest): void {
  copyStringEnumParam(body, {}, "moderation", SUPPORTED_MODERATION_VALUES);
  copyIntegerRangeParam(body, {}, "output_compression", 0, 100);
  copyIntegerRangeParam(body, {}, "partial_images", 0, 3);
  readOptionalString(body.user, "user");

  if (body.style !== undefined && body.style !== null) {
    throw new HttpError(
      400,
      "Invalid parameter: style is only supported for dall-e-3, not Cloudflare gpt-image-2",
      "invalid_request_error",
      "style"
    );
  }
}

function copyStringEnumParam(
  source: OpenAIImageGenerationRequest,
  target: Record<string, unknown>,
  key: string,
  allowedValues: Set<string>
): void {
  const value = source[key];
  if (value === undefined || value === null) {
    return;
  }

  if (typeof value !== "string" || !allowedValues.has(value)) {
    throw new HttpError(
      400,
      `Invalid parameter: ${key} must be one of ${Array.from(allowedValues).join(", ")}`,
      "invalid_request_error",
      key
    );
  }

  target[key] = value;
}

function copyIntegerRangeParam(
  source: OpenAIImageGenerationRequest,
  target: Record<string, unknown>,
  key: string,
  min: number,
  max: number
): void {
  const value = source[key];
  if (value === undefined || value === null) {
    return;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(
      400,
      `Invalid parameter: ${key} must be an integer between ${min} and ${max}`,
      "invalid_request_error",
      key
    );
  }

  target[key] = value;
}

async function runCloudflareImageModel(
  env: Env,
  model: string,
  input: Record<string, unknown>
): Promise<CloudflareAiImageResult> {
  try {
    return (await env.AI.run(model as string & {}, input)) as unknown as CloudflareAiImageResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cloudflare AI Gateway request failed";
    throw new HttpError(502, message, "upstream_error");
  }
}

function extractFirstImage(result: CloudflareAiImageResult): string | undefined {
  if (typeof result.b64_json === "string") {
    return result.b64_json;
  }

  if (typeof result.image === "string") {
    return result.image;
  }

  if (typeof result.url === "string") {
    return result.url;
  }

  if (typeof result.result?.b64_json === "string") {
    return result.result.b64_json;
  }

  if (typeof result.result?.image === "string") {
    return result.result.image;
  }

  if (typeof result.result?.url === "string") {
    return result.result.url;
  }

  const first = extractFirstImageData(result);
  return first?.b64_json ?? first?.image ?? first?.url;
}

function extractFirstImageData(
  result: CloudflareAiImageResult
): { b64_json?: string; image?: string; revised_prompt?: string; url?: string } | undefined {
  return result.data?.find((item) => item.b64_json ?? item.image ?? item.url);
}

function extractResponseMetadata(result: CloudflareAiImageResult): OpenAIImagesResponseMetadata {
  return {
    ...pickResponseMetadata(result.result),
    ...pickResponseMetadata(result)
  };
}

function pickResponseMetadata(source: CloudflareAiImageResult["result"] | CloudflareAiImageResult): OpenAIImagesResponseMetadata {
  if (!source) {
    return {};
  }

  const metadata: OpenAIImagesResponseMetadata = {};
  if (typeof source.background === "string") {
    metadata.background = source.background;
  }
  if (typeof source.output_format === "string") {
    metadata.output_format = source.output_format;
  }
  if (typeof source.quality === "string") {
    metadata.quality = source.quality;
  }
  if (typeof source.size === "string") {
    metadata.size = source.size;
  }
  if (source.usage !== undefined) {
    metadata.usage = source.usage;
  }

  return metadata;
}

function withRevisedPrompt(data: OpenAIImageData, revisedPrompt: string | undefined): OpenAIImageData {
  if (!revisedPrompt) {
    return data;
  }

  return { ...data, revised_prompt: revisedPrompt };
}

async function imageToUrl(image: string): Promise<string> {
  if (isHttpUrl(image)) {
    return image;
  }

  if (isDataUrl(image)) {
    return image;
  }

  return `data:image/png;base64,${stripDataUrlPrefix(image)}`;
}

async function imageToBase64(image: string): Promise<string> {
  if (isDataUrl(image)) {
    return stripDataUrlPrefix(image);
  }

  if (!isHttpUrl(image)) {
    return image;
  }

  const response = await fetch(image);
  if (!response.ok) {
    throw new HttpError(502, `Failed to fetch generated image URL: HTTP ${response.status}`, "upstream_error");
  }

  const buffer = await response.arrayBuffer();
  return arrayBufferToBase64(buffer);
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("https://") || value.startsWith("http://");
}

function isDataUrl(value: string): boolean {
  return value.startsWith("data:");
}

function stripDataUrlPrefix(value: string): string {
  const commaIndex = value.indexOf(",");
  return commaIndex >= 0 ? value.slice(commaIndex + 1) : value;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}
