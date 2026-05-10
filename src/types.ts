export interface Env {
  AI: Ai;
  BRIDGE_API_KEY?: string;
  DEFAULT_IMAGE_MODEL?: string;
  PUBLIC_MODEL_PREFIX?: string;
}

export interface OpenAIImageGenerationRequest {
  model?: string;
  prompt?: unknown;
  n?: unknown;
  size?: unknown;
  response_format?: unknown;
  quality?: unknown;
  style?: unknown;
  user?: unknown;
  background?: unknown;
  moderation?: unknown;
  output_compression?: unknown;
  output_format?: unknown;
  partial_images?: unknown;
  [key: string]: unknown;
}

export interface OpenAIImageData {
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
}

export interface OpenAIImagesResponse {
  created: number;
  data: OpenAIImageData[];
}

export interface CloudflareAiImageResult {
  image?: string;
  url?: string;
  b64_json?: string;
  result?: {
    image?: string;
    url?: string;
    b64_json?: string;
  };
  data?: Array<{ url?: string; b64_json?: string; image?: string }>;
  [key: string]: unknown;
}
