export type OpenAIErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "not_found_error"
  | "upstream_error"
  | "server_error";

export class HttpError extends Error {
  readonly status: number;
  readonly type: OpenAIErrorType;
  readonly param: string | undefined;

  constructor(status: number, message: string, type: OpenAIErrorType, param?: string) {
    super(message);
    this.status = status;
    this.type = type;
    this.param = param;
  }
}

export function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers
    }
  });
}

export function openAIErrorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return jsonResponse(
      {
        error: {
          message: error.message,
          type: error.type,
          param: error.param ?? null,
          code: null
        }
      },
      error.status
    );
  }

  const message = error instanceof Error ? error.message : "Unexpected server error";
  return jsonResponse(
    {
      error: {
        message,
        type: "server_error",
        param: null,
        code: null
      }
    },
    500
  );
}
