"use client";

import { Check, Plug, Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import { Badge, Button, Field, Input, Select, Switch, Tabs, type TabItem } from "@/components/ui";
import { formatKnownUserLabel } from "@/features/known-users/format";
import type { KnownUser } from "@/features/known-users/server/schema";
import type { ApiErrorBody } from "@/lib/api-error";
import type { Settings } from "../server/schema";

/**
 * Bot settings editor. Client Component with two tabs: **Core** (the LLM
 * connection + model, Telegram token, owner, and maintenance mode — without which
 * the bot cannot run) and **Integrations** (optional feature keys like Tavily for
 * web search). One Save button below the tabs persists every changed field
 * regardless of the active tab. Secret keys are write-only — shown as
 * "configured" but their values never leave the server.
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
  knownUsers = [],
}: {
  initial: Settings;
  /** Models preloaded server-side for the saved endpoint, so the dropdown is
   *  populated on open without a manual "Test connection". */
  initialModels?: string[];
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
      setOwnerUserId(data.ownerUserId ?? "");
      setMaintenanceMode(data.maintenanceModeEnabled);
      setTimezone(data.timezone);
      setSave({ kind: "saved" });
      // Re-read server state so masked "configured" placeholders reflect the save.
      router.refresh();
    } catch {
      setSave({ kind: "error", message: "Network error — could not reach the server" });
    }
  }

  const connected = conn.kind === "connected";
  const canPickModel = models.length > 0;

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
