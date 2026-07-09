import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ApiError } from "@/lib/api-error";
import { defineRoute, ok, parseJson, parseQuery, toApiError } from "@/server/http";

function jsonRequest(body: unknown, url = "http://test/api"): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("ok", () => {
  it("wraps data in the shared envelope", async () => {
    const res = ok({ id: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 1 } });
  });
});

describe("toApiError", () => {
  it("passes through ApiError", () => {
    const err = ApiError.notFound();
    expect(toApiError(err)).toBe(err);
  });

  it("maps ZodError to validation_error", () => {
    const parsed = z.object({ n: z.number() }).safeParse({ n: "x" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const mapped = toApiError(parsed.error);
    expect(mapped.code).toBe("validation_error");
    expect(mapped.status).toBe(422);
  });

  it("maps unknown errors to internal_error without leaking the message", () => {
    const mapped = toApiError(new Error("secret detail"));
    expect(mapped.code).toBe("internal_error");
    expect(mapped.message).toBe("Internal server error");
  });
});

describe("parseJson", () => {
  it("validates a JSON body", async () => {
    const schema = z.object({ name: z.string() });
    await expect(parseJson(jsonRequest({ name: "a" }), schema)).resolves.toEqual({
      name: "a",
    });
  });

  it("rejects invalid JSON with bad_request", async () => {
    const req = new Request("http://test/api", { method: "POST", body: "{not json" });
    await expect(parseJson(req, z.unknown())).rejects.toMatchObject({
      code: "bad_request",
    });
  });
});

describe("parseQuery", () => {
  it("parses and validates search params", () => {
    const req = new Request("http://test/api?limit=5");
    const schema = z.object({ limit: z.coerce.number() });
    expect(parseQuery(req, schema)).toEqual({ limit: 5 });
  });
});

describe("defineRoute", () => {
  it("returns the body's response on success", async () => {
    const handler = defineRoute(async ({ params }) => ok({ params }));
    const res = await handler(new Request("http://test/api"), {
      params: Promise.resolve({ id: "42" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { params: { id: "42" } } });
  });

  it("maps thrown ApiError to the shared error envelope", async () => {
    const handler = defineRoute(async () => {
      throw ApiError.notFound("missing");
    });
    const res = await handler(new Request("http://test/api"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: "missing" },
    });
  });

  it("maps unexpected errors to 500 without leaking details", async () => {
    const handler = defineRoute(async () => {
      throw new Error("internal secret");
    });
    const res = await handler(new Request("http://test/api"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("internal_error");
    expect(JSON.stringify(body)).not.toContain("internal secret");
  });
});
