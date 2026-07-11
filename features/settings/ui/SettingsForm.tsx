"use client";

import { Check, Plug, Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import { Badge, Button, Field, Input, Select } from "@/components/ui";
import type { ApiErrorBody } from "@/lib/api-error";
import type { Settings } from "../server/schema";

/**
 * LLM connection editor. Client Component: enter the OpenAI-compatible endpoint
 * (and optional API key), test the connection to load the endpoint's models,
 * then pick the model and save. The API key is write-only — it is shown as
 * "configured" but its value never leaves the server.
 */

type Conn =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "connected"; count: number }
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
}: {
  initial: Settings;
  /** Models preloaded server-side for the saved endpoint, so the dropdown is
   *  populated on open without a manual "Test connection". */
  initialModels?: string[];
}) {
  const router = useRouter();
  const [llmBaseUrl, setLlmBaseUrl] = useState(initial.llmBaseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyDirty, setApiKeyDirty] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [botTokenDirty, setBotTokenDirty] = useState(false);
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

  async function onSave() {
    setSave({ kind: "saving" });
    const patch: Record<string, unknown> = {
      llmBaseUrl: llmBaseUrl.trim() === "" ? null : llmBaseUrl.trim(),
      model: model === "" ? null : model,
    };
    if (apiKeyDirty) patch.apiKey = apiKey.trim() === "" ? null : apiKey.trim();
    if (botTokenDirty) patch.telegramBotToken = botToken.trim() === "" ? null : botToken.trim();

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
      setApiKeyDirty(false);
      setApiKey("");
      setBotTokenDirty(false);
      setBotToken("");
      setSave({ kind: "saved" });
      // Re-read server state so masked "configured" placeholders reflect the save.
      router.refresh();
    } catch {
      setSave({ kind: "error", message: "Network error — could not reach the server" });
    }
  }

  const connected = conn.kind === "connected";
  const canPickModel = models.length > 0;

  return (
    <form onSubmit={onTest} className="space-y-5">
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
