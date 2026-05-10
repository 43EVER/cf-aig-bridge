# cf-aig-bridge

Cloudflare Workers bridge that exposes Cloudflare AI Gateway image generation models through the OpenAI Images API shape.

The initial target is Cloudflare's OpenAI `gpt-image-2` model. Cloudflare Workers AI returns an image URL for this model, while OpenAI-compatible clients usually expect `POST /v1/images/generations` to return `data[].b64_json` by default. This Worker translates that response so existing OpenAI Images API clients can call the Cloudflare-backed model.

## API

### `POST /v1/images/generations`

Request shape follows OpenAI's image generation endpoint for the supported subset:

```json
{
  "model": "gpt-image-2",
  "prompt": "a studio photo of a tiny glass robot",
  "n": 1,
  "size": "1024x1024",
  "response_format": "b64_json"
}
```

Response:

```json
{
  "created": 1778342400,
  "data": [
    {
      "b64_json": "..."
    }
  ]
}
```

Supported behavior:

- `prompt` is required.
- `model` defaults to `DEFAULT_IMAGE_MODEL` or `gpt-image-2`.
- `model: "gpt-image-2"` maps to Cloudflare `openai/gpt-image-2`.
- `n` is implemented by issuing one Cloudflare image request per requested image.
- `response_format` supports `b64_json` and `url`; default is `b64_json`.
- `size`, `quality`, `background`, and `output_format` are forwarded when present.
- OpenAI client-only parameters such as `moderation`, `output_compression`, `partial_images`, and `user` are validated but not forwarded to Cloudflare.
- `style` is rejected because it is DALL-E-specific and not supported by Cloudflare `gpt-image-2`.

### `POST /v1/images/edits`

Accepts OpenAI-style image edit requests and maps them to Cloudflare `openai/gpt-image-2` by passing input images through the model's `images` array.

JSON request example:

```json
{
  "model": "gpt-image-2",
  "prompt": "turn this sketch into a realistic product photo",
  "images": [
    {
      "image_url": "data:image/png;base64,..."
    }
  ],
  "size": "1024x1024",
  "response_format": "b64_json"
}
```

Multipart form requests using `image` or `image[]` file fields are also accepted for OpenAI SDK compatibility. The bridge base64-encodes uploaded files before calling Cloudflare. JSON `image_url` values may be data URLs/base64 strings or HTTP(S) URLs; HTTP(S) inputs are fetched by the Worker and converted to data URLs before calling Cloudflare.

Unsupported edit behavior:

- `mask` is rejected because Cloudflare `openai/gpt-image-2` does not expose a mask parameter.
- `file_id` image references are rejected because the bridge does not implement OpenAI Files API storage.

### `POST /v1/images/variations`

OpenAI's image variations endpoint is DALL-E-2-specific. This bridge still exposes the endpoint for OpenAI Images API clients by adapting it to a `gpt-image-2` image edit request with a fixed variation prompt.

Multipart `image` and `image[]` fields are accepted, as are JSON `image` / `images` values. The endpoint returns `url` responses by default, matching OpenAI's legacy variations behavior; pass `response_format: "b64_json"` for base64 JSON output.

### `GET /v1/models`

Returns a minimal OpenAI-compatible model list for client discovery.

### `GET /healthz`

Returns a simple health response.

## Configuration

`wrangler.jsonc` binds Cloudflare Workers AI as `env.AI`.

Runtime vars/secrets:

- `AI_GATEWAY_ID`: Cloudflare AI Gateway id used for proxied OpenAI models; defaults to `default`.
- `BRIDGE_API_KEY`: optional bearer token required for all routes.
- `DEFAULT_IMAGE_MODEL`: defaults image generation requests when the client omits `model`.
- `PUBLIC_MODEL_PREFIX`: optional prefix stripped from inbound model IDs and prepended in `/v1/models`.

Set the bridge key as a secret:

```bash
npx wrangler secret put BRIDGE_API_KEY
```

## Development

```bash
npm install
npm test
npm run typecheck
npm run dev
```

Tests mock `env.AI.run`; the Cloudflare Workers test runtime may still print a generic Workers AI billing warning because the binding exists in `wrangler.jsonc`.

Local test request:

```bash
curl -sS http://127.0.0.1:8787/v1/images/generations \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer dev-secret' \
  -d '{"model":"gpt-image-2","prompt":"a small red cube","response_format":"url"}'
```

## Source Protocol References

- Cloudflare Workers AI OpenAI `gpt-image-2`: https://developers.cloudflare.com/ai/models/openai/gpt-image-2/
- OpenAI Images API generate method: https://developers.openai.com/api/reference/resources/images/methods/generate
- OpenAI Images API edit method: https://developers.openai.com/api/reference/resources/images/methods/edit
- OpenAI Images API variations method: https://developers.openai.com/api/reference/resources/images/methods/create_variation
