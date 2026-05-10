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
- `size`, `quality`, `style`, `background`, `moderation`, `output_compression`, `output_format`, and `partial_images` are forwarded when present.

### `GET /v1/models`

Returns a minimal OpenAI-compatible model list for client discovery.

### `GET /healthz`

Returns a simple health response.

## Configuration

`wrangler.jsonc` binds Cloudflare Workers AI as `env.AI`.

Runtime vars/secrets:

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
