import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

const PNG_BYTES = new Uint8Array([137, 80, 78, 71]);

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    AI: {
      run: vi.fn(async () => ({ image: "data:image/png;base64,aGVsbG8=" }))
    } as unknown as Ai,
    ...overrides
  };
}

function postImageGeneration(body: Record<string, unknown>, init: RequestInit = {}): Request {
  return new Request("https://bridge.example/v1/images/generations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...init.headers
    },
    body: JSON.stringify(body)
  });
}

function postImageEdit(body: Record<string, unknown>, init: RequestInit = {}): Request {
  return new Request("https://bridge.example/v1/images/edits", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...init.headers
    },
    body: JSON.stringify(body)
  });
}

async function parseJson<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function aiRunMock(env: Env): ReturnType<typeof vi.fn> {
  return env.AI.run as unknown as ReturnType<typeof vi.fn>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAI-compatible endpoint routing", () => {
  it.each(["/", "/healthz", "/v1"])("serves health metadata from %s", async (path) => {
    const env = makeEnv();
    const response = await worker.fetch(new Request(`https://bridge.example${path}`), env);
    const body = await parseJson(response);

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, service: "cf-aig-bridge" });
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it.each(["/v1/models", "/models"])("serves an OpenAI-style model list from %s", async (path) => {
    const env = makeEnv({ DEFAULT_IMAGE_MODEL: "openai/gpt-image-2", PUBLIC_MODEL_PREFIX: "cf:" });
    const response = await worker.fetch(new Request(`https://bridge.example${path}`), env);
    const body = await parseJson<{
      data: Array<{ id: string; object: string; owned_by: string }>;
      object: string;
    }>(response);

    expect(response.status).toBe(200);
    expect(body.object).toBe("list");
    expect(body.data).toEqual([{ id: "cf:gpt-image-2", object: "model", created: 0, owned_by: "cloudflare" }]);
  });

  it("returns an OpenAI error envelope for unknown endpoints", async () => {
    const env = makeEnv();
    const response = await worker.fetch(new Request("https://bridge.example/v1/images/unknown"), env);
    const body = await parseJson(response);

    expect(response.status).toBe(404);
    expect(body).toMatchObject({
      error: {
        type: "not_found_error",
        param: null,
        code: null
      }
    });
  });
});

describe("OpenAI Images API request compatibility", () => {
  it("returns an OpenAI-compatible image generation response with b64_json by default", async () => {
    const env = makeEnv();
    const response = await worker.fetch(postImageGeneration({ model: "gpt-image-2", prompt: "draw a small cube" }), env);
    const body = await parseJson<{ created: number; data: Array<{ b64_json: string }> }>(response);

    expect(response.status).toBe(200);
    expect(Number.isInteger(body.created)).toBe(true);
    expect(body.data).toEqual([{ b64_json: "aGVsbG8=" }]);
    expect(aiRunMock(env).mock.calls[0]).toEqual(["openai/gpt-image-2", { prompt: "draw a small cube" }]);
  });

  it("strips public model prefixes and forwards only upstream-supported input fields", async () => {
    const env = makeEnv({ PUBLIC_MODEL_PREFIX: "cf:" });
    const requestBody = {
      model: "cf:gpt-image-2",
      prompt: "a translucent robot on a desk",
      size: "1024x1024",
      quality: "high",
      background: "transparent",
      moderation: "auto",
      output_compression: 72,
      output_format: "png",
      partial_images: 2,
      stream: false,
      user: "end-user-123"
    };

    const response = await worker.fetch(postImageGeneration(requestBody), env);

    expect(response.status).toBe(200);
    expect(aiRunMock(env).mock.calls[0]).toEqual([
      "openai/gpt-image-2",
      {
        prompt: "a translucent robot on a desk",
        size: "1024x1024",
        quality: "high",
        background: "transparent",
        output_format: "png"
      }
    ]);
  });

  it("uses DEFAULT_IMAGE_MODEL when clients omit model", async () => {
    const env = makeEnv({ DEFAULT_IMAGE_MODEL: "gpt-image-2" });
    const response = await worker.fetch(postImageGeneration({ prompt: "use configured default" }), env);

    expect(response.status).toBe(200);
    expect(aiRunMock(env).mock.calls[0][0]).toBe("openai/gpt-image-2");
  });

  it("does not double-prefix already Cloudflare-qualified OpenAI model IDs", async () => {
    const env = makeEnv();
    const response = await worker.fetch(postImageGeneration({ model: "openai/gpt-image-2", prompt: "qualified" }), env);

    expect(response.status).toBe(200);
    expect(aiRunMock(env).mock.calls[0][0]).toBe("openai/gpt-image-2");
  });

  it("supports n by issuing multiple Cloudflare image requests", async () => {
    const env = makeEnv({
      AI: {
        run: vi
          .fn()
          .mockResolvedValueOnce({ image: "data:image/png;base64,Zmlyc3Q=" })
          .mockResolvedValueOnce({ image: "data:image/png;base64,c2Vjb25k" })
      } as unknown as Ai
    });
    const response = await worker.fetch(postImageGeneration({ prompt: "two variants", n: 2 }), env);
    const body = await parseJson(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      data: [{ b64_json: "Zmlyc3Q=" }, { b64_json: "c2Vjb25k" }]
    });
    expect(env.AI.run).toHaveBeenCalledTimes(2);
  });

  it("returns url responses without fetching Cloudflare URL output", async () => {
    const env = makeEnv({
      AI: {
        run: vi.fn(async () => ({ result: { image: "https://imagedelivery.net/generated.png" } }))
      } as unknown as Ai
    });
    const request = new Request("https://bridge.example/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "url mode", response_format: "url" })
    });

    const response = await worker.fetch(request, env);
    const body = await parseJson(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      data: [{ url: "https://imagedelivery.net/generated.png" }]
    });
  });

  it("converts upstream image URLs to b64_json for the default response format", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } }))
    );
    const env = makeEnv({
      AI: {
        run: vi.fn(async () => ({ result: { image: "https://imagedelivery.net/generated.png" } }))
      } as unknown as Ai
    });

    const response = await worker.fetch(postImageGeneration({ prompt: "fetch url" }), env);
    const body = await parseJson(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ data: [{ b64_json: "iVBORw==" }] });
    expect(fetch).toHaveBeenCalledWith("https://imagedelivery.net/generated.png");
  });

  it("extracts OpenAI-style data array items and preserves revised_prompt", async () => {
    const env = makeEnv({
      AI: {
        run: vi.fn(async () => ({
          data: [{ b64_json: "ZGF0YQ==", revised_prompt: "a revised image prompt" }]
        }))
      } as unknown as Ai
    });

    const response = await worker.fetch(postImageGeneration({ prompt: "openai array" }), env);
    const body = await parseJson(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      data: [{ b64_json: "ZGF0YQ==", revised_prompt: "a revised image prompt" }]
    });
  });

  it("preserves OpenAI image generation response metadata returned by upstream", async () => {
    const env = makeEnv({
      AI: {
        run: vi.fn(async () => ({
          result: {
            image: "data:image/png;base64,bWV0YQ==",
            background: "transparent",
            output_format: "png",
            quality: "high",
            size: "1024x1024",
            usage: { total_tokens: 32 }
          }
        }))
      } as unknown as Ai
    });

    const response = await worker.fetch(postImageGeneration({ prompt: "metadata" }), env);
    const body = await parseJson(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      background: "transparent",
      output_format: "png",
      quality: "high",
      size: "1024x1024",
      usage: { total_tokens: 32 },
      data: [{ b64_json: "bWV0YQ==" }]
    });
  });
});

describe("OpenAI Images Edit API request compatibility", () => {
  it("adapts JSON image_url edits to Cloudflare gpt-image-2 images input", async () => {
    const env = makeEnv({
      AI: {
        run: vi.fn(async () => ({ result: { image: "data:image/png;base64,ZWRpdA==" } }))
      } as unknown as Ai
    });
    const response = await worker.fetch(
      postImageEdit({
        model: "gpt-image-2",
        prompt: "turn it into a clay sculpture",
        images: [{ image_url: "data:image/png;base64,aW5wdXQ=" }],
        size: "1024x1024",
        quality: "medium",
        output_format: "png"
      }),
      env
    );
    const body = await parseJson(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ data: [{ b64_json: "ZWRpdA==" }] });
    expect(aiRunMock(env).mock.calls[0]).toEqual([
      "openai/gpt-image-2",
      {
        prompt: "turn it into a clay sculpture",
        images: ["data:image/png;base64,aW5wdXQ="],
        size: "1024x1024",
        quality: "medium",
        output_format: "png"
      }
    ]);
  });

  it("accepts a single JSON image string for OpenAI SDK compatibility", async () => {
    const env = makeEnv();
    const response = await worker.fetch(
      postImageEdit({ prompt: "edit the image", image: "data:image/png;base64,aW1n" }),
      env
    );

    expect(response.status).toBe(200);
    expect(aiRunMock(env).mock.calls[0][1]).toMatchObject({
      prompt: "edit the image",
      images: ["data:image/png;base64,aW1n"]
    });
  });

  it("fetches JSON image_url inputs before calling Cloudflare", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } }))
    );
    const env = makeEnv();
    const response = await worker.fetch(
      postImageEdit({ prompt: "edit remote image", images: [{ image_url: "https://cdn.example/input.png" }] }),
      env
    );

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledWith("https://cdn.example/input.png");
    expect(aiRunMock(env).mock.calls[0][1]).toMatchObject({
      prompt: "edit remote image",
      images: ["data:image/png;base64,iVBORw=="]
    });
  });

  it("accepts multipart image files using OpenAI image[] form fields", async () => {
    const env = makeEnv();
    const form = new FormData();
    form.set("prompt", "multipart edit");
    form.append("image[]", new File([PNG_BYTES], "input.png", { type: "image/png" }));
    form.set("size", "1024x1536");
    form.set("response_format", "url");

    const response = await worker.fetch(
      new Request("https://bridge.example/images/edits", {
        method: "POST",
        body: form
      }),
      env
    );
    const body = await parseJson(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ data: [{ url: "data:image/png;base64,aGVsbG8=" }] });
    expect(aiRunMock(env).mock.calls[0]).toEqual([
      "openai/gpt-image-2",
      {
        prompt: "multipart edit",
        images: ["iVBORw=="],
        size: "1024x1536"
      }
    ]);
  });

  it("rejects image edits without an image", async () => {
    const env = makeEnv();
    const response = await worker.fetch(postImageEdit({ prompt: "missing image" }), env);
    const body = await parseJson(response);

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: {
        type: "invalid_request_error",
        param: "image"
      }
    });
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("rejects file_id image edits because the bridge has no OpenAI Files API backing", async () => {
    const env = makeEnv();
    const response = await worker.fetch(postImageEdit({ prompt: "file id", images: [{ file_id: "file-abc" }] }), env);
    const body = await parseJson(response);

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: {
        type: "invalid_request_error",
        param: "image"
      }
    });
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("rejects masks because Cloudflare gpt-image-2 does not expose a mask parameter", async () => {
    const env = makeEnv();
    const response = await worker.fetch(
      postImageEdit({ prompt: "masked edit", image: "data:image/png;base64,aW1n", mask: "data:image/png;base64,bWFzaw==" }),
      env
    );
    const body = await parseJson(response);

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: {
        type: "invalid_request_error",
        param: "mask"
      }
    });
    expect(env.AI.run).not.toHaveBeenCalled();
  });
});

describe("OpenAI Images Variation API request compatibility", () => {
  it("adapts image variations to Cloudflare gpt-image-2 edits", async () => {
    const env = makeEnv();
    const form = new FormData();
    form.append("image", new File([PNG_BYTES], "input.png", { type: "image/png" }));
    form.set("n", "2");

    const response = await worker.fetch(
      new Request("https://bridge.example/v1/images/variations", {
        method: "POST",
        body: form
      }),
      env
    );
    const body = await parseJson(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      data: [{ url: "data:image/png;base64,aGVsbG8=" }, { url: "data:image/png;base64,aGVsbG8=" }]
    });
    expect(env.AI.run).toHaveBeenCalledTimes(2);
    expect(aiRunMock(env).mock.calls[0]).toEqual([
      "openai/gpt-image-2",
      {
        prompt: "Create a natural variation of the provided image while preserving its main subject and overall composition.",
        images: ["iVBORw=="]
      }
    ]);
  });

  it("rejects image variations without an image", async () => {
    const env = makeEnv();
    const response = await worker.fetch(
      new Request("https://bridge.example/v1/images/variations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      }),
      env
    );

    expect(response.status).toBe(400);
    expect(env.AI.run).not.toHaveBeenCalled();
  });
});

describe("OpenAI-style validation and error behavior", () => {
  it("requires the configured bearer token", async () => {
    const env = makeEnv({ BRIDGE_API_KEY: "secret" });
    const request = new Request("https://bridge.example/v1/models");

    const response = await worker.fetch(request, env);
    const body = await parseJson(response);

    expect(response.status).toBe(401);
    expect(body).toMatchObject({
      error: { type: "authentication_error" }
    });
  });

  it("accepts the configured bearer token", async () => {
    const env = makeEnv({ BRIDGE_API_KEY: "secret" });
    const request = postImageGeneration(
      { prompt: "authorized" },
      {
        headers: { authorization: "Bearer secret" }
      }
    );

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
  });

  it("rejects missing prompts using OpenAI error shape", async () => {
    const env = makeEnv();
    const response = await worker.fetch(postImageGeneration({ model: "gpt-image-2" }), env);
    const body = await parseJson(response);

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: {
        type: "invalid_request_error",
        param: "prompt"
      }
    });
  });

  it.each([
    ["n", 0],
    ["n", 1.5],
    ["n", 11],
    ["model", ""],
    ["size", 1024],
    ["size", "1792x1024"],
    ["quality", true],
    ["quality", "ultra"],
    ["background", 123],
    ["background", "white"],
    ["moderation", "strict"],
    ["output_compression", "80"],
    ["output_compression", 101],
    ["output_compression", 12.5],
    ["output_format", "gif"],
    ["partial_images", "2"],
    ["partial_images", 4],
    ["partial_images", 1.5],
    ["stream", "false"],
    ["stream", true],
    ["style", "vivid"],
    ["user", 123],
    ["response_format", "json"]
  ])("rejects invalid %s values", async (param, value) => {
    const env = makeEnv();
    const response = await worker.fetch(postImageGeneration({ prompt: "invalid", [param]: value }), env);
    const body = await parseJson(response);

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: {
        type: "invalid_request_error",
        param
      }
    });
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("rejects non-JSON content before calling upstream", async () => {
    const env = makeEnv();
    const request = new Request("https://bridge.example/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "prompt=hello"
    });

    const response = await worker.fetch(request, env);
    const body = await parseJson(response);

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ error: { type: "invalid_request_error" } });
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON before calling upstream", async () => {
    const env = makeEnv();
    const request = new Request("https://bridge.example/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{"
    });

    const response = await worker.fetch(request, env);
    const body = await parseJson(response);

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ error: { type: "invalid_request_error" } });
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("rejects non-POST image generation requests", async () => {
    const env = makeEnv();
    const response = await worker.fetch(new Request("https://bridge.example/v1/images/generations"), env);
    const body = await parseJson(response);

    expect(response.status).toBe(405);
    expect(body).toMatchObject({ error: { type: "invalid_request_error" } });
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("maps upstream AI failures to OpenAI-style upstream errors", async () => {
    const env = makeEnv({
      AI: {
        run: vi.fn(async () => {
          throw new Error("Cloudflare rejected the request");
        })
      } as unknown as Ai
    });

    const response = await worker.fetch(postImageGeneration({ prompt: "upstream fails" }), env);
    const body = await parseJson(response);

    expect(response.status).toBe(502);
    expect(body).toMatchObject({
      error: {
        message: "Cloudflare rejected the request",
        type: "upstream_error",
        param: null,
        code: null
      }
    });
  });

  it("fails clearly when upstream returns no image payload", async () => {
    const env = makeEnv({
      AI: {
        run: vi.fn(async () => ({ result: {} }))
      } as unknown as Ai
    });

    const response = await worker.fetch(postImageGeneration({ prompt: "empty upstream" }), env);
    const body = await parseJson(response);

    expect(response.status).toBe(502);
    expect(body).toMatchObject({
      error: {
        type: "upstream_error"
      }
    });
  });

  it("maps failed image URL fetches to upstream errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    const env = makeEnv({
      AI: {
        run: vi.fn(async () => ({ image: "https://imagedelivery.net/missing.png" }))
      } as unknown as Ai
    });

    const response = await worker.fetch(postImageGeneration({ prompt: "missing url" }), env);
    const body = await parseJson(response);

    expect(response.status).toBe(502);
    expect(body).toMatchObject({
      error: {
        message: "Failed to fetch generated image URL: HTTP 404",
        type: "upstream_error"
      }
    });
  });
});
