import { testTranscriptionSchema } from "@/features/settings/server/schema";
import { testTranscription } from "@/features/settings/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Probe the transcription endpoint by transcribing a fraction of a second of
 * generated silence — a real `/v1/audio/transcriptions` call, since whisper-class
 * servers often serve it without `/v1/models`. Backs the "Test transcription
 * endpoint" action on the settings form.
 */
export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, testTranscriptionSchema);
  return ok(await testTranscription(input, { kind: "dashboard" }));
});
