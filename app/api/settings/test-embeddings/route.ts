import { testEmbeddingsSchema } from "@/features/settings/server/schema";
import { testEmbeddings } from "@/features/settings/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Probe the embedding endpoint by embedding a short string, returning the model
 * and the vector width it produced. Backs the "Test embeddings" action on the
 * settings form — a real call, so it also catches a model whose width does not
 * match the stored vector columns.
 */
export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, testEmbeddingsSchema);
  return ok(await testEmbeddings(input, { kind: "dashboard" }));
});
