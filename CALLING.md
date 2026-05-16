# cf-aig-bridge Calling Guide

This service exposes Cloudflare AI Gateway image models through an OpenAI-compatible Images API shape. The current production deployment is:

```text
https://cf-aig-bridge.i-807.workers.dev
```

All routes require a bearer token when `BRIDGE_API_KEY` is configured.

## Quick Start

Set these variables locally:

```bash
export CF_AIG_BRIDGE_BASE_URL="https://cf-aig-bridge.i-807.workers.dev"
export CF_AIG_BRIDGE_API_KEY="<your bridge api key>"
```

If you are calling from the same machine where the production key was generated, you can load it from the local config file:

```bash
export CF_AIG_BRIDGE_API_KEY="$(tr -d '\n' < ~/.config/cf-aig-bridge/bridge_api_key)"
```

Generate one image and return a temporary URL:

```bash
curl -sS "$CF_AIG_BRIDGE_BASE_URL/v1/images/generations" \
  -H "authorization: Bearer $CF_AIG_BRIDGE_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "a small red cube on a plain white table",
    "quality": "low",
    "size": "1024x1024",
    "output_format": "png",
    "response_format": "url"
  }'
```

Successful response:

```json
{
  "created": 1778950000,
  "data": [
    {
      "url": "https://ai-gateway-outputs..."
    }
  ]
}
```

## Authentication

Send the bridge key as an OpenAI-style bearer token:

```http
Authorization: Bearer <your bridge api key>
```

Missing or wrong keys return:

```json
{
  "error": {
    "message": "Incorrect API key provided",
    "type": "authentication_error",
    "param": null,
    "code": null
  }
}
```

Do not put the key in source code, public client-side code, browser URLs, logs, or committed config files.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Health check. Requires auth when `BRIDGE_API_KEY` is set. |
| `GET` | `/v1/models` | Minimal OpenAI-compatible model list. |
| `POST` | `/v1/images/generations` | Generate images. |
| `POST` | `/v1/images/edits` | Edit an image using `gpt-image-2` image input. |
| `POST` | `/v1/images/variations` | OpenAI-compatible variation shim implemented as a `gpt-image-2` edit. |

Legacy aliases without `/v1` are also accepted for image endpoints:

```text
/images/generations
/images/edits
/images/variations
```

## Models

Client-facing model IDs:

| Client model | Cloudflare model |
|---|---|
| `gpt-image-2` | `openai/gpt-image-2` |
| `gpt-image-1.5` | `openai/gpt-image-1.5` |

If `model` is omitted, the Worker uses `DEFAULT_IMAGE_MODEL`; the production default is currently `gpt-image-2`.

The current bridge is designed for OpenAI image models. Non-OpenAI Cloudflare models such as `google/imagen-4` or `bytedance/seedream-*` need separate model-specific adapters before they can be exposed through this API shape.

## Response Formats

Supported `response_format` values:

| Value | Response field | Notes |
|---|---|---|
| `b64_json` | `data[].b64_json` | Base64 image bytes. Default for generations and edits. |
| `url` | `data[].url` | Temporary Cloudflare AI Gateway output URL. Usually easier for manual testing. |

Defaults:

| Endpoint | Default `response_format` |
|---|---|
| `/v1/images/generations` | `b64_json` |
| `/v1/images/edits` | `b64_json` |
| `/v1/images/variations` | `url` |

## Generate Images

Endpoint:

```text
POST /v1/images/generations
```

Supported request fields:

| Field | Type | Required | Supported values / behavior |
|---|---|---:|---|
| `prompt` | string | yes | Text prompt. |
| `model` | string | no | `gpt-image-2`, `gpt-image-1.5`, or Cloudflare-qualified `openai/...`. Defaults to `gpt-image-2` in production. |
| `n` | integer | no | `1` to `10`. Implemented as repeated upstream calls. |
| `size` | string | no | `1024x1024`, `1024x1536`, `1536x1024`, `auto`. |
| `quality` | string | no | `low`, `medium`, `high`, `auto`. |
| `response_format` | string | no | `b64_json` or `url`. Default: `b64_json`. |
| `background` | string | no | `opaque` or `auto` are usable with `gpt-image-2`. `transparent` is accepted by the bridge but currently rejected by Cloudflare upstream for `gpt-image-2`. |
| `output_format` | string | no | `png`, `webp`, `jpeg`. |
| `output_compression` | integer | no | `0` to `100`. Validated for OpenAI compatibility, not forwarded to Cloudflare. |
| `partial_images` | integer | no | `0` to `3`. Validated for OpenAI compatibility, not forwarded to Cloudflare. |
| `moderation` | string | no | `low` or `auto`. Validated for OpenAI compatibility, not forwarded to Cloudflare. |
| `user` | string | no | Validated for OpenAI compatibility, not forwarded to Cloudflare. |
| `stream` | boolean | no | `false` is accepted. `true` is rejected because streaming images are not supported by this bridge. |

URL response example:

```bash
curl -sS "$CF_AIG_BRIDGE_BASE_URL/v1/images/generations" \
  -H "authorization: Bearer $CF_AIG_BRIDGE_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "a clean product photo of a tiny matte black cube",
    "quality": "low",
    "size": "1024x1024",
    "background": "opaque",
    "output_format": "png",
    "response_format": "url"
  }'
```

Base64 response example:

```bash
curl -sS "$CF_AIG_BRIDGE_BASE_URL/v1/images/generations" \
  -H "authorization: Bearer $CF_AIG_BRIDGE_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "a minimal blue origami boat on a neutral background",
    "quality": "low",
    "size": "1024x1024",
    "output_format": "png",
    "response_format": "b64_json"
  }'
```

Multiple images:

```bash
curl -sS "$CF_AIG_BRIDGE_BASE_URL/v1/images/generations" \
  -H "authorization: Bearer $CF_AIG_BRIDGE_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "three distinct silver coin icon concepts",
    "quality": "auto",
    "size": "auto",
    "n": 2,
    "response_format": "url"
  }'
```

## Edit Images

Endpoint:

```text
POST /v1/images/edits
```

Supported JSON image inputs:

```json
{
  "image": "data:image/png;base64,..."
}
```

```json
{
  "images": [
    {
      "image_url": "https://example.com/input.png"
    }
  ]
}
```

The Worker accepts:

- Data URLs.
- Raw base64 strings.
- HTTP(S) image URLs. The Worker fetches them and converts them to data URLs before calling Cloudflare.
- Multipart form uploads using `image` or `image[]` fields.

Supported request fields are the same as generation, plus:

| Field | Type | Required | Supported values / behavior |
|---|---|---:|---|
| `image` | string, object, or array | yes, unless `images` is provided | Input image or images. |
| `images` | string, object, or array | yes, unless `image` is provided | Alias used by the bridge for OpenAI SDK compatibility. |
| `input_fidelity` | string | no | `low` or `high`. Validated for OpenAI compatibility, not forwarded to Cloudflare. |
| `mask` | any | no | Rejected. Cloudflare `gpt-image-2` does not expose a mask parameter. |
| `file_id` | string | no | Rejected. This bridge does not implement OpenAI Files API storage. |

JSON edit example:

```bash
curl -sS "$CF_AIG_BRIDGE_BASE_URL/v1/images/edits" \
  -H "authorization: Bearer $CF_AIG_BRIDGE_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "Keep the same object, recolor it blue, and add a thin green outline",
    "images": [
      {
        "image_url": "https://example.com/input.png"
      }
    ],
    "quality": "low",
    "size": "1024x1024",
    "output_format": "png",
    "input_fidelity": "high",
    "response_format": "url"
  }'
```

Multipart edit example:

```bash
curl -sS "$CF_AIG_BRIDGE_BASE_URL/v1/images/edits" \
  -H "authorization: Bearer $CF_AIG_BRIDGE_API_KEY" \
  -F "model=gpt-image-2" \
  -F "prompt=Turn this sketch into a realistic product photo" \
  -F "image=@./input.png" \
  -F "quality=low" \
  -F "size=1024x1024" \
  -F "response_format=url"
```

## Create Variations

Endpoint:

```text
POST /v1/images/variations
```

OpenAI's variations endpoint is historically DALL-E-2-specific. This bridge exposes it for client compatibility by turning the input image into a `gpt-image-2` edit request with a fixed variation prompt.

Variation example:

```bash
curl -sS "$CF_AIG_BRIDGE_BASE_URL/v1/images/variations" \
  -H "authorization: Bearer $CF_AIG_BRIDGE_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "image": {
      "image_url": "https://example.com/input.png"
    },
    "n": 1,
    "quality": "low",
    "size": "1024x1024",
    "response_format": "url"
  }'
```

## OpenAI SDK Usage

Because this bridge uses OpenAI-compatible paths and bearer auth, most OpenAI SDK clients can point their base URL at the Worker. Use the bridge key as the SDK API key.

### JavaScript / TypeScript

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.CF_AIG_BRIDGE_API_KEY,
  baseURL: "https://cf-aig-bridge.i-807.workers.dev/v1"
});

const result = await client.images.generate({
  model: "gpt-image-2",
  prompt: "a small red cube on a plain white table",
  size: "1024x1024",
  quality: "low",
  response_format: "url"
});

console.log(result.data?.[0]?.url);
```

### Python

```python
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["CF_AIG_BRIDGE_API_KEY"],
    base_url="https://cf-aig-bridge.i-807.workers.dev/v1",
)

result = client.images.generate(
    model="gpt-image-2",
    prompt="a small red cube on a plain white table",
    size="1024x1024",
    quality="low",
    response_format="url",
)

print(result.data[0].url)
```

## Error Shape

Errors follow an OpenAI-style envelope:

```json
{
  "error": {
    "message": "Invalid parameter: size must be one of 1024x1024, 1024x1536, 1536x1024, auto",
    "type": "invalid_request_error",
    "param": "size",
    "code": null
  }
}
```

Common statuses:

| HTTP | Meaning |
|---:|---|
| `400` | Invalid request or unsupported parameter. |
| `401` | Missing or incorrect bridge API key. |
| `402` | Cloudflare AI Gateway upstream payment failure. |
| `405` | Wrong method for the endpoint. |
| `502` | Cloudflare upstream failed or returned an unsupported payload. |

## Known Limitations

- `background: "transparent"` currently fails for Cloudflare `openai/gpt-image-2` with an upstream user input error. Use `opaque` or `auto`.
- `mask` is not supported for edits.
- `stream: true` is not supported.
- `file_id` image inputs are not supported because this bridge has no Files API storage.
- `n > 1` is implemented by issuing repeated upstream requests, so latency and cost scale roughly linearly.
- `output_compression`, `partial_images`, `moderation`, `input_fidelity`, and `user` are validated for OpenAI compatibility but are not forwarded to Cloudflare.
- Cloudflare output URLs are temporary signed URLs. Use `b64_json` if the caller needs to store the image bytes directly.

## Operational Notes

Production currently uses the `aifuckclaude` AI Gateway via the Worker `AI_GATEWAY_ID` variable.

To rotate the bridge API key:

```bash
openssl rand -base64 48 > ~/.config/cf-aig-bridge/bridge_api_key
npx wrangler secret put BRIDGE_API_KEY < ~/.config/cf-aig-bridge/bridge_api_key
```

After rotation, verify:

```bash
curl -sS "$CF_AIG_BRIDGE_BASE_URL/v1/models" \
  -H "authorization: Bearer $CF_AIG_BRIDGE_API_KEY"
```
