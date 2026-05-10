import { jsonResponse } from "./errors";
import type { Env } from "./types";

export function handleModels(env: Env): Response {
  const model = env.DEFAULT_IMAGE_MODEL ?? "gpt-image-2";
  const publicPrefix = env.PUBLIC_MODEL_PREFIX ?? "";
  const id = model.startsWith("openai/") ? `${publicPrefix}${model.slice("openai/".length)}` : `${publicPrefix}${model}`;

  return jsonResponse({
    object: "list",
    data: [
      {
        id,
        object: "model",
        created: 0,
        owned_by: "cloudflare"
      }
    ]
  });
}
