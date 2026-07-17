"use client";

import { Check, Plug, Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import { Badge, Button, Field, Input, Select, Switch, Tabs, type TabItem } from "@/components/ui";
import { formatKnownUserLabel } from "@/features/known-users/format";
import type { KnownUser } from "@/features/known-users/server/schema";
import type { ApiErrorBody } from "@/lib/api-error";
import { EMBEDDING_DIMENSIONS } from "@/lib/embeddings";
import type { Settings } from "../server/schema";

/**
 * Bot settings editor. Client Component with three tabs: **Core** (the LLM
 * connection + model, Telegram token, owner, and maintenance mode — without which
 * the bot cannot run), **Embeddings** (the endpoint powering semantic recall over
 * history summaries), and **Integrations** (optional feature keys like Tavily for
 * web search). One Save button below the tabs persists every changed field
 * regardless of the active tab. Secret keys are write-only — shown as
 * "configured" but their values never leave the server.
 */

type Conn =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "connected"; count: number }
  | { kind: "error"; message: string };

/** Outcome of the embeddings probe — a real embed call, so it reports the width. */
type Embed =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; model: string; dimensions: number }
  | { kind: "error"; message: string };

/** Outcome of the image probe — checks the model is served, without drawing one. */
type ImageTest =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; model: string; modelCount: number }
  | { kind: "error"; message: string };

type Save =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    return body.error?.message ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

export function SettingsForm({
  initial,
  initialModels = [],
  initialEmbeddingModels = [],
  initialImageModels = [],
  knownUsers = [],
}: {
  initial: Settings;
  /** Models preloaded server-side for the saved endpoint, so the dropdown is
   *  populated on open without a manual "Test connection". */
  initialModels?: string[];
  /** Models preloaded from the embedding endpoint (or the LLM one, when it serves both). */
  initialEmbeddingModels?: string[];
  /** Models preloaded from the image endpoint (or the LLM one, when it serves both). */
  initialImageModels?: string[];
  /** Users who have messaged the bot — the owner is chosen from this list. */
  knownUsers?: KnownUser[];
}) {
  const router = useRouter();
  const [llmBaseUrl, setLlmBaseUrl] = useState(initial.llmBaseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyDirty, setApiKeyDirty] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [botTokenDirty, setBotTokenDirty] = useState(false);
  const [tavilyKey, setTavilyKey] = useState("");
  const [tavilyKeyDirty, setTavilyKeyDirty] = useState(false);
  const [ownerUserId, setOwnerUserId] = useState(initial.ownerUserId ?? "");
  const [maintenanceMode, setMaintenanceMode] = useState(initial.maintenanceModeEnabled);
  const [timezone, setTimezone] = useState(initial.timezone);
  const [dailyJobsRunTime, setDailyJobsRunTime] = useState(initial.dailyJobsRunTime);
  const [embeddingBaseUrl, setEmbeddingBaseUrl] = useState(initial.embeddingBaseUrl ?? "");
  // A stored embedding URL *is* the "separate backend" flag — the two can never
  // disagree, so the checkbox is derived from it rather than persisted alongside it.
  const [separateEmbeddingBackend, setSeparateEmbeddingBackend] = useState(
    Boolean(initial.embeddingBaseUrl),
  );
  const [embeddingKey, setEmbeddingKey] = useState("");
  const [embeddingKeyDirty, setEmbeddingKeyDirty] = useState(false);
  const [embeddingModel, setEmbeddingModel] = useState(initial.embeddingModel ?? "");
  const [embed, setEmbed] = useState<Embed>({ kind: "idle" });
  const [imageBaseUrl, setImageBaseUrl] = useState(initial.imageBaseUrl ?? "");
  // Same derivation as the embedding backend flag: a stored URL *is* the flag.
  const [separateImageBackend, setSeparateImageBackend] = useState(Boolean(initial.imageBaseUrl));
  const [imageKey, setImageKey] = useState("");
  const [imageKeyDirty, setImageKeyDirty] = useState(false);
  const [imageModel, setImageModel] = useState(initial.imageModel ?? "");
  const [imageProbe, setImageProbe] = useState<ImageTest>({ kind: "idle" });
  const [model, setModel] = useState(initial.model ?? "");
  // Seed with the server-preloaded list (falling back to just the saved model);
  // a successful "Test connection" replaces this with a fresh list.
  const [models, setModels] = useState<string[]>(
    initialModels.length > 0 ? initialModels : initial.model ? [initial.model] : [],
  );
  const [conn, setConn] = useState<Conn>({ kind: "idle" });
  const [save, setSave] = useState<Save>({ kind: "idle" });

  // Probe the endpoint (a user action, not an effect) and settle `conn`/`models`.
  const runTest = useCallback(async (baseUrl: string, key: string | undefined) => {
    setConn({ kind: "testing" });
    try {
      const res = await fetch("/api/settings/test-connection", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ llmBaseUrl: baseUrl, ...(key !== undefined ? { apiKey: key } : {}) }),
      });
      if (!res.ok) {
        setConn({ kind: "error", message: await readError(res) });
        return;
      }
      const { data } = (await res.json()) as { data: { models: string[] } };
      setModels(data.models);
      setConn({ kind: "connected", count: data.models.length });
    } catch {
      setConn({ kind: "error", message: "Network error — could not reach the server" });
    }
  }, []);

  async function onTest(event: React.FormEvent) {
    event.preventDefault();
    if (llmBaseUrl.trim() === "") return;
    await runTest(llmBaseUrl, apiKeyDirty ? apiKey : undefined);
  }

  // The embedding endpoint as configured right now: its own URL only when the
  // operator asked for a separate backend, otherwise "reuse the LLM connection"
  // (null). Used identically by the probe and the save, so a passing test is a
  // test of what will actually be stored.
  const resolvedEmbeddingUrl =
    separateEmbeddingBackend && embeddingBaseUrl.trim() !== "" ? embeddingBaseUrl.trim() : null;
  const embeddingUrlMissing = separateEmbeddingBackend && embeddingBaseUrl.trim() === "";

  // Probe the embedding endpoint with a real embed call: it reports the vector
  // width, which is the one thing a model listing cannot tell us and the one
  // mismatch that would break every later write.
  async function onTestEmbeddings() {
    if (embeddingModel.trim() === "" || embeddingUrlMissing) return;
    setEmbed({ kind: "testing" });
    try {
      const res = await fetch("/api/settings/test-embeddings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          embeddingBaseUrl: resolvedEmbeddingUrl,
          embeddingModel: embeddingModel,
          // Only send the key when the operator typed one; otherwise the server
          // tests with the stored key and the secret never round-trips.
          ...(embeddingKeyDirty ? { embeddingApiKey: embeddingKey.trim() } : {}),
        }),
      });
      if (!res.ok) {
        setEmbed({ kind: "error", message: await readError(res) });
        return;
      }
      const { data } = (await res.json()) as { data: { model: string; dimensions: number } };
      setEmbed({ kind: "ok", model: data.model, dimensions: data.dimensions });
    } catch {
      setEmbed({ kind: "error", message: "Network error — could not reach the server" });
    }
  }

  // The image endpoint as configured right now — same "resolve exactly as the
  // runtime will" rule as the embedding pair above, so a passing test is a test of
  // what gets stored.
  const resolvedImageUrl =
    separateImageBackend && imageBaseUrl.trim() !== "" ? imageBaseUrl.trim() : null;
  const imageUrlMissing = separateImageBackend && imageBaseUrl.trim() === "";

  // Probe the image endpoint. Unlike embeddings this does not make a real
  // generation — nothing about an image can only be learned by drawing it, and a
  // diffusion model would keep the operator waiting minutes for the answer.
  async function onTestImages() {
    if (imageModel.trim() === "" || imageUrlMissing) return;
    setImageProbe({ kind: "testing" });
    try {
      const res = await fetch("/api/settings/test-images", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          imageBaseUrl: resolvedImageUrl,
          imageModel: imageModel,
          // Only send the key when the operator typed one; otherwise the server
          // tests with the stored key and the secret never round-trips.
          ...(imageKeyDirty ? { imageApiKey: imageKey.trim() } : {}),
        }),
      });
      if (!res.ok) {
        setImageProbe({ kind: "error", message: await readError(res) });
        return;
      }
      const { data } = (await res.json()) as { data: { model: string; modelCount: number } };
      setImageProbe({ kind: "ok", model: data.model, modelCount: data.modelCount });
    } catch {
      setImageProbe({ kind: "error", message: "Network error — could not reach the server" });
    }
  }

  async function onSave() {
    setSave({ kind: "saving" });
    const patch: Record<string, unknown> = {
      llmBaseUrl: llmBaseUrl.trim() === "" ? null : llmBaseUrl.trim(),
      model: model === "" ? null : model,
    };
    if (apiKeyDirty) patch.apiKey = apiKey.trim() === "" ? null : apiKey.trim();
    if (botTokenDirty) patch.telegramBotToken = botToken.trim() === "" ? null : botToken.trim();
    if (tavilyKeyDirty) patch.tavilyApiKey = tavilyKey.trim() === "" ? null : tavilyKey.trim();
    if (ownerUserId !== (initial.ownerUserId ?? "")) {
      patch.ownerUserId = ownerUserId === "" ? null : ownerUserId;
    }
    if (maintenanceMode !== initial.maintenanceModeEnabled) {
      patch.maintenanceModeEnabled = maintenanceMode;
    }
    if (timezone.trim() !== initial.timezone && timezone.trim() !== "") {
      patch.timezone = timezone.trim();
    }
    if (dailyJobsRunTime.trim() !== initial.dailyJobsRunTime && dailyJobsRunTime.trim() !== "") {
      patch.dailyJobsRunTime = dailyJobsRunTime.trim();
    }
    if (resolvedEmbeddingUrl !== (initial.embeddingBaseUrl ?? null)) {
      patch.embeddingBaseUrl = resolvedEmbeddingUrl;
    }
    if (embeddingModel !== (initial.embeddingModel ?? "")) {
      patch.embeddingModel = embeddingModel === "" ? null : embeddingModel;
    }
    // Turning the separate backend off clears its key too: it authenticated a host
    // we are no longer calling, and leaving it behind would resurrect on re-enable.
    if (!separateEmbeddingBackend && initial.embeddingApiKeyConfigured) {
      patch.embeddingApiKey = null;
    } else if (embeddingKeyDirty) {
      patch.embeddingApiKey = embeddingKey.trim() === "" ? null : embeddingKey.trim();
    }
    if (resolvedImageUrl !== (initial.imageBaseUrl ?? null)) {
      patch.imageBaseUrl = resolvedImageUrl;
    }
    if (imageModel !== (initial.imageModel ?? "")) {
      patch.imageModel = imageModel === "" ? null : imageModel;
    }
    // Same rule as the embedding key above: dropping the separate backend drops
    // the key that authenticated it.
    if (!separateImageBackend && initial.imageApiKeyConfigured) {
      patch.imageApiKey = null;
    } else if (imageKeyDirty) {
      patch.imageApiKey = imageKey.trim() === "" ? null : imageKey.trim();
    }

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        setSave({ kind: "error", message: await readError(res) });
        return;
      }
      const { data } = (await res.json()) as { data: Settings };
      setApiKeyDirty(false);
      setApiKey("");
      setBotTokenDirty(false);
      setBotToken("");
      setTavilyKeyDirty(false);
      setTavilyKey("");
      setEmbeddingKeyDirty(false);
      setEmbeddingKey("");
      setOwnerUserId(data.ownerUserId ?? "");
      setMaintenanceMode(data.maintenanceModeEnabled);
      setTimezone(data.timezone);
      setDailyJobsRunTime(data.dailyJobsRunTime);
      setEmbeddingBaseUrl(data.embeddingBaseUrl ?? "");
      setSeparateEmbeddingBackend(Boolean(data.embeddingBaseUrl));
      setEmbeddingModel(data.embeddingModel ?? "");
      setImageKeyDirty(false);
      setImageKey("");
      setImageBaseUrl(data.imageBaseUrl ?? "");
      setSeparateImageBackend(Boolean(data.imageBaseUrl));
      setImageModel(data.imageModel ?? "");
      setSave({ kind: "saved" });
      // Re-read server state so masked "configured" placeholders reflect the save.
      router.refresh();
    } catch {
      setSave({ kind: "error", message: "Network error — could not reach the server" });
    }
  }

  const connected = conn.kind === "connected";
  const canPickModel = models.length > 0;

  // Embedding model options. When embeddings share the LLM endpoint (the common
  // case — no separate URL), the endpoint's own model list is authoritative, so a
  // "Test connection" on the Core tab refreshes this dropdown too. With a separate
  // embedding host we fall back to what the server preloaded from that host. The
  // saved model is always kept as an option, so an unreachable endpoint cannot
  // silently blank out a working selection.
  const listedEmbeddingModels =
    !separateEmbeddingBackend && models.length > 0 ? models : initialEmbeddingModels;
  const embeddingModels =
    embeddingModel && !listedEmbeddingModels.includes(embeddingModel)
      ? [embeddingModel, ...listedEmbeddingModels]
      : listedEmbeddingModels;

  // Image model options, resolved exactly like the embedding ones above.
  const listedImageModels =
    !separateImageBackend && models.length > 0 ? models : initialImageModels;
  const imageModels =
    imageModel && !listedImageModels.includes(imageModel)
      ? [imageModel, ...listedImageModels]
      : listedImageModels;

  const coreTab = (
    <div className="space-y-5">
      <Field
        id="llmBaseUrl"
        label="OpenAI-compatible API URL"
        hint="e.g. https://api.openai.com/v1 or http://localhost:11434/v1"
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            type="url"
            inputMode="url"
            value={llmBaseUrl}
            onChange={(e) => {
              setLlmBaseUrl(e.target.value);
              setConn({ kind: "idle" });
            }}
            placeholder="https://api.openai.com/v1"
          />
        )}
      </Field>

      <Field
        id="apiKey"
        label="API key"
        hint="Optional — required by hosted providers, not by local ones. Stored securely; never shown again."
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setApiKeyDirty(true);
            }}
            placeholder={initial.apiKeyConfigured && !apiKeyDirty ? "•••••••• (configured)" : "optional"}
          />
        )}
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          variant="outline"
          disabled={conn.kind === "testing" || llmBaseUrl.trim() === ""}
          leftIcon={<Plug className="h-4 w-4" />}
        >
          {conn.kind === "testing" ? "Testing…" : "Test connection"}
        </Button>
        {connected ? (
          <Badge tone="success" dot>
            Connected — {conn.count} models
          </Badge>
        ) : null}
        {conn.kind === "error" ? <span className="text-sm text-danger">{conn.message}</span> : null}
      </div>

      <Field
        id="model"
        label="Model"
        hint={
          canPickModel
            ? "Select the chat model used for replies."
            : "Test the connection to load available models."
        }
      >
        {({ id, describedBy }) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            value={model}
            disabled={!canPickModel}
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="">Select a model…</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <Field
        id="telegramBotToken"
        label="Telegram bot token"
        hint="From @BotFather. Stored securely; never shown again. Save, then start the bot from the Overview."
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            type="password"
            autoComplete="off"
            value={botToken}
            onChange={(e) => {
              setBotToken(e.target.value);
              setBotTokenDirty(true);
            }}
            placeholder={
              initial.telegramBotTokenConfigured && !botTokenDirty
                ? "•••••••• (configured)"
                : "123456:ABC-DEF…"
            }
          />
        )}
      </Field>

      <Field
        id="ownerUserId"
        label="Owner"
        hint={
          knownUsers.length > 0
            ? "The bot owner controls maintenance mode. Chosen from users who have messaged the bot."
            : "No users yet — the owner is chosen from people who have messaged the bot. Start the bot and message it first."
        }
      >
        {({ id, describedBy }) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            value={ownerUserId}
            disabled={knownUsers.length === 0}
            onChange={(e) => setOwnerUserId(e.target.value)}
          >
            <option value="">No owner</option>
            {knownUsers.map((u) => (
              <option key={u.userId} value={u.userId}>
                {formatKnownUserLabel(u)}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <Field
        id="maintenanceMode"
        label="Maintenance mode"
        hint="When on, the bot stays fully functional for the owner only; everyone else gets a static maintenance notice."
      >
        {({ id, describedBy }) => (
          <div className="flex items-center gap-3">
            <Switch
              id={id}
              aria-describedby={describedBy}
              checked={maintenanceMode}
              onChange={(e) => setMaintenanceMode(e.target.checked)}
            />
            <span className="text-sm text-muted">{maintenanceMode ? "On" : "Off"}</span>
          </div>
        )}
      </Field>

      <Field
        id="timezone"
        label="Timezone"
        hint="IANA timezone for scheduled tasks — a task at '09:00 daily' fires at 09:00 here. e.g. Europe/Berlin."
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="UTC"
          />
        )}
      </Field>

      <Field
        id="dailyJobsRunTime"
        label="Daily jobs run time"
        hint="Local time (HH:MM, in the timezone above) the nightly jobs run: distilling user feedback into preferences, and compressing each finished chat-day into searchable topic summaries."
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            value={dailyJobsRunTime}
            onChange={(e) => setDailyJobsRunTime(e.target.value)}
            placeholder="04:00"
          />
        )}
      </Field>
    </div>
  );

  const embeddingsTab = (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        Embeddings power semantic recall over older conversations: the daily job turns each chat-day
        into topic summaries and embeds them, so the bot can find what was discussed weeks ago even
        when the wording differs. Without an embedding model the summaries are still written and
        keyword-searchable — only the semantic half is off.
      </p>

      <Field
        id="separateEmbeddingBackend"
        label="Separate embedding backend"
        hint="Off: embeddings are requested from the same backend as the LLM. On: they are served by a different host, which you give below."
      >
        {({ id, describedBy }) => (
          <div className="flex items-center gap-3">
            <Switch
              id={id}
              aria-describedby={describedBy}
              checked={separateEmbeddingBackend}
              onChange={(e) => {
                setSeparateEmbeddingBackend(e.target.checked);
                setEmbed({ kind: "idle" });
              }}
            />
            <span className="text-sm text-muted">
              {separateEmbeddingBackend ? "Own backend" : "Same backend as the LLM"}
            </span>
          </div>
        )}
      </Field>

      {/* Only shown when the operator asked for a separate backend — otherwise there
          is nothing to fill in, and an empty URL field would invite the question of
          what a blank one means. */}
      {separateEmbeddingBackend ? (
        <>
          <Field
            id="embeddingBaseUrl"
            label="Embedding API URL"
            hint="Required — the host serving /v1/embeddings."
            error={embeddingUrlMissing ? "An embedding API URL is required." : undefined}
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                type="url"
                inputMode="url"
                required
                value={embeddingBaseUrl}
                onChange={(e) => {
                  setEmbeddingBaseUrl(e.target.value);
                  setEmbed({ kind: "idle" });
                }}
                placeholder="https://embeddings.example.com/v1"
              />
            )}
          </Field>

          <Field
            id="embeddingApiKey"
            label="Embedding API key"
            hint="Optional — required only if that host needs one. Stored securely; never shown again."
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                type="password"
                autoComplete="off"
                value={embeddingKey}
                onChange={(e) => {
                  setEmbeddingKey(e.target.value);
                  setEmbeddingKeyDirty(true);
                }}
                placeholder={
                  initial.embeddingApiKeyConfigured && !embeddingKeyDirty
                    ? "•••••••• (configured)"
                    : "optional"
                }
              />
            )}
          </Field>
        </>
      ) : null}

      <Field
        id="embeddingModel"
        label="Embedding model"
        hint={`Must emit ${EMBEDDING_DIMENSIONS}-dimensional vectors (e.g. bge-m3) — the width this database stores. Test below to confirm.`}
      >
        {({ id, describedBy }) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            value={embeddingModel}
            disabled={embeddingModels.length === 0}
            onChange={(e) => {
              setEmbeddingModel(e.target.value);
              setEmbed({ kind: "idle" });
            }}
          >
            <option value="">No embedding model (semantic recall off)</option>
            {embeddingModels.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={onTestEmbeddings}
          disabled={embed.kind === "testing" || embeddingModel.trim() === "" || embeddingUrlMissing}
          leftIcon={<Plug className="h-4 w-4" />}
        >
          {embed.kind === "testing" ? "Testing…" : "Test embeddings"}
        </Button>
        {embed.kind === "ok" ? (
          <Badge tone="success" dot>
            {embed.model} — {embed.dimensions} dimensions
          </Badge>
        ) : null}
        {embed.kind === "error" ? (
          <span className="text-sm text-danger">{embed.message}</span>
        ) : null}
      </div>
    </div>
  );

  const imagesTab = (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        Image generation lets the bot draw a picture when someone asks it to, and send it to the
        chat. Each image it sends is then recognized like any received photo, so later replies know
        what it drew. Without an image model the tool is simply not offered — the bot says it cannot
        make images rather than pretending to.
      </p>

      <Field
        id="separateImageBackend"
        label="Separate image backend"
        hint="Off: images are requested from the same backend as the LLM. On: they are served by a different host, which you give below."
      >
        {({ id, describedBy }) => (
          <div className="flex items-center gap-3">
            <Switch
              id={id}
              aria-describedby={describedBy}
              checked={separateImageBackend}
              onChange={(e) => {
                setSeparateImageBackend(e.target.checked);
                setImageProbe({ kind: "idle" });
              }}
            />
            <span className="text-sm text-muted">
              {separateImageBackend ? "Own backend" : "Same backend as the LLM"}
            </span>
          </div>
        )}
      </Field>

      {separateImageBackend ? (
        <>
          <Field
            id="imageBaseUrl"
            label="Image API URL"
            hint="Required — the host serving /v1/images/generations."
            error={imageUrlMissing ? "An image API URL is required." : undefined}
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                type="url"
                inputMode="url"
                required
                value={imageBaseUrl}
                onChange={(e) => {
                  setImageBaseUrl(e.target.value);
                  setImageProbe({ kind: "idle" });
                }}
                placeholder="https://images.example.com/v1"
              />
            )}
          </Field>

          <Field
            id="imageApiKey"
            label="Image API key"
            hint="Optional — required only if that host needs one. Stored securely; never shown again."
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                type="password"
                autoComplete="off"
                value={imageKey}
                onChange={(e) => {
                  setImageKey(e.target.value);
                  setImageKeyDirty(true);
                }}
                placeholder={
                  initial.imageApiKeyConfigured && !imageKeyDirty
                    ? "•••••••• (configured)"
                    : "optional"
                }
              />
            )}
          </Field>
        </>
      ) : null}

      <Field
        id="imageModel"
        label="Image model"
        hint="The model asked to draw. Test below to confirm the endpoint actually serves it."
      >
        {({ id, describedBy }) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            value={imageModel}
            disabled={imageModels.length === 0}
            onChange={(e) => {
              setImageModel(e.target.value);
              setImageProbe({ kind: "idle" });
            }}
          >
            <option value="">No image model (image generation off)</option>
            {imageModels.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={onTestImages}
          disabled={
            imageProbe.kind === "testing" || imageModel.trim() === "" || imageUrlMissing
          }
          leftIcon={<Plug className="h-4 w-4" />}
        >
          {imageProbe.kind === "testing" ? "Testing…" : "Test image endpoint"}
        </Button>
        {imageProbe.kind === "ok" ? (
          <Badge tone="success" dot>
            {imageProbe.model} — served ({imageProbe.modelCount} models)
          </Badge>
        ) : null}
        {imageProbe.kind === "error" ? (
          <span className="text-sm text-danger">{imageProbe.message}</span>
        ) : null}
      </div>
    </div>
  );

  const integrationsTab = (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        Optional integrations that unlock extra tools. The bot runs without these.
      </p>

      <Field
        id="tavilyApiKey"
        label="Tavily API key"
        hint="Enables the web-search tool. Stored securely; never shown again."
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            type="password"
            autoComplete="off"
            value={tavilyKey}
            onChange={(e) => {
              setTavilyKey(e.target.value);
              setTavilyKeyDirty(true);
            }}
            placeholder={
              initial.webSearchConfigured && !tavilyKeyDirty
                ? "•••••••• (configured)"
                : "tvly-…"
            }
          />
        )}
      </Field>
    </div>
  );

  const tabs: TabItem[] = [
    { id: "core", label: "Core", content: coreTab },
    { id: "embeddings", label: "Embeddings", content: embeddingsTab },
    { id: "images", label: "Images", content: imagesTab },
    { id: "integrations", label: "Integrations", content: integrationsTab },
  ];

  return (
    <form onSubmit={onTest} className="space-y-6">
      <Tabs tabs={tabs} />

      <div className="flex items-center gap-3 border-t border-border pt-4">
        <Button
          type="button"
          onClick={onSave}
          disabled={save.kind === "saving"}
          leftIcon={<Save className="h-4 w-4" />}
        >
          {save.kind === "saving" ? "Saving…" : "Save settings"}
        </Button>
        {save.kind === "saved" ? (
          <span className="inline-flex items-center gap-1 text-sm text-success">
            <Check className="h-4 w-4" aria-hidden /> Saved
          </span>
        ) : null}
        {save.kind === "error" ? <span className="text-sm text-danger">{save.message}</span> : null}
      </div>
    </form>
  );
}
