import { HttpError, jsonResponse, openAIErrorResponse } from "./errors";
import {
  handleImageEdit,
  handleImageGeneration,
  handleImageVariation,
  isImagesEditsPath,
  isImagesGenerationsPath,
  isImagesVariationsPath
} from "./images";
import { handleModels } from "./models";
import type { Env } from "./types";

const HEALTH_PATHS = new Set(["/", "/healthz", "/v1"]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      enforceAuth(request, env);

      const url = new URL(request.url);
      if (HEALTH_PATHS.has(url.pathname)) {
        return jsonResponse({ ok: true, service: "cf-aig-bridge" });
      }

      if (url.pathname === "/v1/models" || url.pathname === "/models") {
        return handleModels(env);
      }

      if (isImagesGenerationsPath(url.pathname)) {
        return await handleImageGeneration(request, env);
      }

      if (isImagesEditsPath(url.pathname)) {
        return await handleImageEdit(request, env);
      }

      if (isImagesVariationsPath(url.pathname)) {
        return await handleImageVariation(request, env);
      }

      throw new HttpError(404, `No route for ${url.pathname}`, "not_found_error");
    } catch (error) {
      return openAIErrorResponse(error);
    }
  }
};

function enforceAuth(request: Request, env: Env): void {
  if (!env.BRIDGE_API_KEY) {
    return;
  }

  const authorization = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${env.BRIDGE_API_KEY}`;
  if (authorization !== expected) {
    throw new HttpError(401, "Incorrect API key provided", "authentication_error");
  }
}
