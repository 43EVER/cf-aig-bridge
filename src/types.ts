export interface Env {
  AI: Ai;
  AI_GATEWAY_ID?: string;
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
  stream?: unknown;
  input_fidelity?: unknown;
  [key: string]: unknown;
}

export interface OpenAIImageEditRequest extends OpenAIImageGenerationRequest {
  image?: unknown;
  images?: unknown;
  mask?: unknown;
}

export interface OpenAIImageVariationRequest extends OpenAIImageEditRequest {}

export interface OpenAIImageInput {
  image_url?: unknown;
  file_id?: unknown;
  [key: string]: unknown;
}

export interface OpenAIImageData {
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
}

export interface OpenAIImagesResponse {
  created: number;
  background?: string;
  data: OpenAIImageData[];
  output_format?: string;
  quality?: string;
  size?: string;
  usage?: unknown;
}

export interface OpenAIImagesResponseMetadata {
  background?: string;
  output_format?: string;
  quality?: string;
  size?: string;
  usage?: unknown;
}

export interface CloudflareAiImageResult {
  image?: string;
  url?: string;
  b64_json?: string;
  background?: string;
  output_format?: string;
  quality?: string;
  size?: string;
  usage?: unknown;
  result?: {
    image?: string;
    url?: string;
    b64_json?: string;
    background?: string;
    output_format?: string;
    quality?: string;
    size?: string;
    usage?: unknown;
  };
  data?: Array<{ url?: string; b64_json?: string; image?: string; revised_prompt?: string }>;
  [key: string]: unknown;
}
