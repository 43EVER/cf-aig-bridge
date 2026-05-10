import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    AI: {
      run: vi.fn(async () => ({ image: "data:image/png;base64,aGVsbG8=" }))
    } as unknown as Ai,
    ...overrides
  };
}

async function parseJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("cf-aig-bridge", () => {
  it("returns an OpenAI-compatible image generation response with b64_json by default", async () => {
    const env = makeEnv();
    const request = new Request("https://bridge.example/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-image-2", prompt: "draw a small cube" })
    });

    const response = await worker.fetch(request, env);
    const body = await parseJson(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      data: [{ b64_json: "aGVsbG8=" }]
    });
    expect((env.AI.run as unknown as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
      "openai/gpt-image-2",
      { prompt: "draw a small cube" }
    ]);
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
    const request = new Request("https://bridge.example/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "two variants", n: 2 })
    });

    const response = await worker.fetch(request, env);
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

  it("extracts Cloudflare gpt-image-2 result.image responses", async () => {
    const env = makeEnv({
      AI: {
        run: vi.fn(async () => ({ result: { image: "data:image/png;base64,Y2Y=" } }))
      } as unknown as Ai
    });
    const request = new Request("https://bridge.example/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "cloudflare wrapped response" })
    });

    const response = await worker.fetch(request, env);
    const body = await parseJson(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      data: [{ b64_json: "Y2Y=" }]
    });
  });

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

  it("rejects missing prompts using OpenAI error shape", async () => {
    const env = makeEnv();
    const request = new Request("https://bridge.example/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-image-2" })
    });

    const response = await worker.fetch(request, env);
    const body = await parseJson(response);

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: {
        type: "invalid_request_error",
        param: "prompt"
      }
    });
  });
});
