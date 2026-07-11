import "server-only";

import { z, type ZodType } from "zod";

import { ApiError, isApiError, type ApiErrorBody } from "@/lib/api-error";

/**
 * Shared Route Handler infrastructure.
 *
 * Route Handlers must stay thin: they declare input/output schemas and a body,
 * and delegate validation, error mapping, and JSON serialization here. This
 * keeps error shapes, status codes, and response envelopes identical across
 * every feature.
 */

/** Standard success envelope. Keeps a stable shape for clients and tests. */
export interface ApiOkBody<T> {
  data: T;
}

/** JSON response for a successful result. */
export function ok<T>(data: T, init?: ResponseInit): Response {
  return Response.json({ data } satisfies ApiOkBody<T>, {
    status: 200,
    ...init,
  });
}

/** JSON response for a failed result, using the shared error envelope. */
export function errorResponse(error: ApiError): Response {
  return Response.json(error.toBody() satisfies ApiErrorBody, {
    status: error.status,
  });
}

/**
 * Pretty-printed JSON file download (`Content-Disposition: attachment`). Shared
 * by every feature's Debug page for log/trace bundle export, so the download
 * shape stays consistent. Not wrapped in the `data` envelope — the body is the
 * file itself.
 */
export function jsonDownload(data: unknown, filename: string): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

/** Map any thrown value to an {@link ApiError} without leaking internals. */
export function toApiError(err: unknown): ApiError {
  if (isApiError(err)) return err;
  if (err instanceof z.ZodError) {
    return new ApiError("validation_error", "Request validation failed", {
      details: err.flatten(),
      cause: err,
    });
  }
  return ApiError.internal("Internal server error", { cause: err });
}

/** Parse and validate a JSON request body, throwing `bad_request` on invalid JSON. */
export async function parseJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw ApiError.badRequest("Request body must be valid JSON");
  }
  return schema.parse(raw);
}

/** Validate URL search params against a schema. */
export function parseQuery<T>(request: Request, schema: ZodType<T>): T {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  return schema.parse(params);
}

/**
 * Context passed to a route body. `params` are the (already-awaited) dynamic
 * route params; the wrapper resolves the Next promise so handlers don't repeat
 * the boilerplate.
 */
export interface RouteBodyContext {
  request: Request;
  params: Record<string, string>;
}

export type RouteBody = (ctx: RouteBodyContext) => Promise<Response> | Response;

/** Next.js passes params as a promise in the second argument. */
interface NextRouteContext {
  params?: Promise<Record<string, string>>;
}

/**
 * Wrap a route body with shared error handling. Any thrown value — `ApiError`,
 * `ZodError`, or unknown — becomes a consistent JSON error response with the
 * correct status.
 *
 * ```ts
 * export const GET = defineRoute(async ({ params }) => ok(await load(params.id)));
 * ```
 */
export function defineRoute(body: RouteBody) {
  return async function handler(
    request: Request,
    context?: NextRouteContext,
  ): Promise<Response> {
    try {
      const params = (await context?.params) ?? {};
      return await body({ request, params });
    } catch (err) {
      return errorResponse(toApiError(err));
    }
  };
}
