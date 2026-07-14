"use client";

import { CalendarClock, Check, Pencil, Play, Plus, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  EmptyState,
  Field,
  Input,
  Select,
  Switch,
} from "@/components/ui";
import { useLiveRefresh } from "@/components/realtime/useLiveRefresh";
import { Timestamp } from "@/components/time/Timestamp";
import { useTimezone } from "@/components/time/TimezoneProvider";
import type { ApiErrorBody } from "@/lib/api-error";

import { describeSchedule } from "../schedule";
import type { ScheduledTask, ScheduleKind } from "../types";

/**
 * Scheduled-tasks manager. Client Component: create, edit, enable/disable, and
 * delete tasks, and trigger "run due now". Each mutation calls the tasks API,
 * then `router.refresh()` re-reads the server-rendered list (also kept fresh live
 * over the `tasks` SSE topic). Built from the shared UI-kit primitives.
 */

/** A pickable target chat (a known DM or group) for a new task. */
export interface ChatOption {
  chatId: string;
  label: string;
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    return body.error?.message ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

/** The schedule sub-form shared by create + edit. */
interface ScheduleFields {
  scheduleKind: ScheduleKind;
  timeOfDay: string;
  weekdays: number[];
  runDate: string;
}

function ScheduleInputs({
  value,
  onChange,
  idPrefix,
  disabled,
}: {
  value: ScheduleFields;
  onChange: (next: ScheduleFields) => void;
  idPrefix: string;
  disabled?: boolean;
}) {
  const toggleDay = (day: number) => {
    const has = value.weekdays.includes(day);
    onChange({
      ...value,
      weekdays: has ? value.weekdays.filter((d) => d !== day) : [...value.weekdays, day].sort(),
    });
  };

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field id={`${idPrefix}-kind`} label="Repeat">
        {({ id }) => (
          <Select
            id={id}
            value={value.scheduleKind}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, scheduleKind: e.target.value as ScheduleKind })}
          >
            <option value="once">Once</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </Select>
        )}
      </Field>
      <Field id={`${idPrefix}-time`} label="Time (HH:MM)">
        {({ id }) => (
          <Input
            id={id}
            type="time"
            value={value.timeOfDay}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, timeOfDay: e.target.value })}
          />
        )}
      </Field>
      {value.scheduleKind === "once" ? (
        <Field id={`${idPrefix}-date`} label="Date">
          {({ id }) => (
            <Input
              id={id}
              type="date"
              value={value.runDate}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, runDate: e.target.value })}
            />
          )}
        </Field>
      ) : null}
      {value.scheduleKind === "weekly" ? (
        <Field id={`${idPrefix}-weekdays`} label="Weekdays" className="sm:col-span-2">
          {() => (
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAY_LABELS.map((label, day) => (
                <Button
                  key={day}
                  type="button"
                  size="sm"
                  variant={value.weekdays.includes(day) ? "primary" : "outline"}
                  disabled={disabled}
                  onClick={() => toggleDay(day)}
                >
                  {label}
                </Button>
              ))}
            </div>
          )}
        </Field>
      ) : null}
    </div>
  );
}

const EMPTY_SCHEDULE: ScheduleFields = {
  scheduleKind: "daily",
  timeOfDay: "09:00",
  weekdays: [],
  runDate: "",
};

/** Only send the fields the schedule kind needs. */
function schedulePayload(s: ScheduleFields) {
  return {
    scheduleKind: s.scheduleKind,
    timeOfDay: s.timeOfDay,
    weekdays: s.scheduleKind === "weekly" ? s.weekdays : [],
    runDate: s.scheduleKind === "once" ? s.runDate : null,
  };
}

function CreateForm({ chats }: { chats: ChatOption[] }) {
  const router = useRouter();
  const [chatId, setChatId] = useState(chats[0]?.chatId ?? "");
  const [instruction, setInstruction] = useState("");
  const [schedule, setSchedule] = useState<ScheduleFields>(EMPTY_SCHEDULE);
  const [state, setState] = useState<"idle" | "saving" | { error: string }>("idle");

  async function create() {
    setState("saving");
    try {
      const res = await fetch("/api/scheduled-tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatId: chatId.trim(), instruction: instruction.trim(), ...schedulePayload(schedule) }),
      });
      if (!res.ok) {
        setState({ error: await readError(res) });
        return;
      }
      setInstruction("");
      setSchedule(EMPTY_SCHEDULE);
      setState("idle");
      router.refresh();
    } catch {
      setState({ error: "Network error — could not reach the server" });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New scheduled task</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field
          id="new-task-chat"
          label="Target chat"
          hint={chats.length === 0 ? "No known chats yet — enter a Telegram chat id." : "The chat the reminder is delivered to."}
        >
          {({ id }) =>
            chats.length > 0 ? (
              <Select id={id} value={chatId} onChange={(e) => setChatId(e.target.value)}>
                {chats.map((c) => (
                  <option key={c.chatId} value={c.chatId}>
                    {c.label}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                id={id}
                value={chatId}
                onChange={(e) => setChatId(e.target.value)}
                placeholder="e.g. 123456789"
                inputMode="numeric"
              />
            )
          }
        </Field>
        <Field
          id="new-task-instruction"
          label="Instruction"
          hint="What to do when it fires — the bot writes a natural message performing this."
        >
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              value={instruction}
              onChange={(e) => {
                setInstruction(e.target.value);
                setState("idle");
              }}
              placeholder="e.g. remind me to take a break"
            />
          )}
        </Field>
        <ScheduleInputs value={schedule} onChange={setSchedule} idPrefix="new-task" />
        <div className="flex items-center gap-3">
          <Button
            onClick={create}
            disabled={chatId.trim() === "" || instruction.trim().length < 2 || state === "saving"}
            leftIcon={<Plus className="h-4 w-4" />}
          >
            {state === "saving" ? "Creating…" : "Create task"}
          </Button>
          {typeof state === "object" ? <span className="text-sm text-danger">{state.error}</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}

function TaskCard({
  task,
  chatLabel,
  authorLabel,
}: {
  task: ScheduledTask;
  chatLabel: string;
  authorLabel: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [instruction, setInstruction] = useState(task.instruction);
  const [schedule, setSchedule] = useState<ScheduleFields>({
    scheduleKind: task.scheduleKind,
    timeOfDay: task.timeOfDay,
    weekdays: task.weekdays ?? [],
    runDate: task.runDate ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resetEdit() {
    setInstruction(task.instruction);
    setSchedule({
      scheduleKind: task.scheduleKind,
      timeOfDay: task.timeOfDay,
      weekdays: task.weekdays ?? [],
      runDate: task.runDate ?? "",
    });
    setError(null);
    setEditing(false);
  }

  async function mutate(run: () => Promise<Response>, after?: () => void) {
    setBusy(true);
    setError(null);
    try {
      const res = await run();
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      after?.();
      router.refresh();
    } catch {
      setError("Network error — could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  const patch = (body: Record<string, unknown>) =>
    fetch(`/api/scheduled-tasks/${encodeURIComponent(task.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const save = () =>
    mutate(() => patch({ instruction: instruction.trim(), ...schedulePayload(schedule) }), () =>
      setEditing(false),
    );

  const toggleEnabled = () => mutate(() => patch({ enabled: !task.enabled }));

  const remove = () => {
    if (!confirm(`Delete this task? "${task.instruction}"`)) return;
    return mutate(() =>
      fetch(`/api/scheduled-tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" }),
    );
  };

  if (editing) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Edit task</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field id={`edit-instruction-${task.id}`} label="Instruction">
            {({ id }) => (
              <Input id={id} value={instruction} onChange={(e) => setInstruction(e.target.value)} />
            )}
          </Field>
          <ScheduleInputs value={schedule} onChange={setSchedule} idPrefix={`edit-${task.id}`} />
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </CardContent>
        <CardFooter>
          <Button
            size="sm"
            onClick={save}
            disabled={busy || instruction.trim().length < 2}
            leftIcon={<Check className="h-4 w-4" />}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
          <Button size="sm" variant="ghost" onClick={resetEdit} disabled={busy} leftIcon={<X className="h-4 w-4" />}>
            Cancel
          </Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <CardTitle className="truncate">{task.instruction}</CardTitle>
            {task.enabled ? (
              <Badge tone="success" dot>
                Enabled
              </Badge>
            ) : (
              <Badge tone="neutral">Disabled</Badge>
            )}
          </div>
          <p className="text-sm text-muted">
            {describeSchedule(task)} · {chatLabel} · {authorLabel}
          </p>
        </div>
        <CardAction>
          <Switch
            checked={task.enabled}
            onChange={toggleEnabled}
            disabled={busy}
            aria-label={task.enabled ? "Disable task" : "Enable task"}
          />
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setEditing(true)}
            disabled={busy}
            aria-label="Edit task"
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={remove} disabled={busy} aria-label="Delete task">
            <Trash2 className="h-4 w-4 text-danger" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted">
          {task.nextRunAt ? (
            <>Next run: <Timestamp iso={task.nextRunAt} /></>
          ) : (
            <span className="text-faint">No upcoming run.</span>
          )}
          {task.lastRunAt ? (
            <> · Last run: <Timestamp iso={task.lastRunAt} /></>
          ) : null}
        </p>
        {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
      </CardContent>
    </Card>
  );
}

export function ScheduledTasksManager({
  tasks,
  chats,
  authors,
}: {
  tasks: ScheduledTask[];
  chats: ChatOption[];
  /** Map of creator user id → display label, for showing each task's author. */
  authors: Record<string, string>;
}) {
  useLiveRefresh("tasks");
  const timezone = useTimezone();
  const router = useRouter();
  const [running, setRunning] = useState(false);

  const chatLabelOf = (chatId: string) =>
    chats.find((c) => c.chatId === chatId)?.label ?? `Chat ${chatId}`;

  const authorLabelOf = (userId: string | null) =>
    userId ? `by ${authors[userId] ?? `user ${userId}`}` : "via dashboard";

  async function runDueNow() {
    setRunning(true);
    try {
      await fetch("/api/scheduled-tasks/run", { method: "POST" });
      router.refresh();
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">Operator timezone: {timezone}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={runDueNow}
          disabled={running}
          leftIcon={<Play className="h-4 w-4" />}
        >
          {running ? "Running…" : "Run due now"}
        </Button>
      </div>

      <CreateForm chats={chats} />

      {tasks.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No scheduled tasks yet"
          description="Create a task above, or ask the bot in a chat to remind you about something."
        />
      ) : (
        <div className="space-y-4">
          {tasks.map((t) => (
            <TaskCard
              key={t.id}
              task={t}
              chatLabel={chatLabelOf(t.chatId)}
              authorLabel={authorLabelOf(t.createdByUserId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
