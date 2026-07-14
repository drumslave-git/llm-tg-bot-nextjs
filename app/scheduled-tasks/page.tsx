import { Bug, Database } from "lucide-react";
import Link from "next/link";

import { Button, EmptyState, PageHeader } from "@/components/ui";
import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import { formatKnownUserLabel } from "@/features/known-users/format";
import { listUsers } from "@/features/known-users/server/service";
import { listGroups } from "@/features/known-groups/server/service";
import { getScheduledTasks } from "@/features/scheduled-tasks/server/service";
import type { ScheduledTask } from "@/features/scheduled-tasks/types";
import {
  ScheduledTasksManager,
  type ChatOption,
} from "@/features/scheduled-tasks/ui/ScheduledTasksManager";
import { featureDebugHref } from "@/lib/features";

// Tasks and chat options are read from the database at request time.
export const dynamic = "force-dynamic";

/**
 * Scheduled-tasks dashboard page. Server Component: lists tasks, resolves the
 * target-chat options (known DMs + groups), and delegates create/edit/
 * enable/delete + "run due now" to a Client Component. Times render in the
 * operator timezone supplied by the root layout's TimezoneProvider.
 */
export default async function ScheduledTasksPage() {
  let tasks: ScheduledTask[] | null = null;
  let chats: ChatOption[] = [];
  let authors: Record<string, string> = {};
  let dbError: string | null = null;
  try {
    const [taskList, users, groups] = await Promise.all([
      getScheduledTasks(),
      listUsers(),
      listGroups(),
    ]);
    tasks = taskList;
    chats = [
      ...users.map((u) => ({
        chatId: u.userId,
        label: `${formatKnownUserLabel(u)} · DM`,
      })),
      ...groups.map((g) => ({
        chatId: g.chatId,
        label: `${g.title ?? `Group ${g.chatId}`} · group`,
      })),
    ];
    authors = Object.fromEntries(users.map((u) => [u.userId, formatKnownUserLabel(u)]));
  } catch (err) {
    dbError = err instanceof Error ? err.message : "Could not read scheduled tasks from the database";
  }

  return (
    <>
      <PageHeader
        title="Scheduled tasks"
        description="Standing reminders the bot delivers on a schedule. Times use the operator timezone in Settings."
        actions={
          <div className="flex items-center gap-2">
            <LiveIndicator topic="tasks" />
            <Button asChild variant="outline" size="sm">
              <Link href={featureDebugHref("scheduled-tasks")}>
                <Bug className="h-4 w-4" aria-hidden />
                Debug
              </Link>
            </Button>
          </div>
        }
      />

      {tasks ? (
        <ScheduledTasksManager tasks={tasks} chats={chats} authors={authors} />
      ) : (
        <EmptyState
          icon={Database}
          title="Database unavailable"
          description={dbError ?? "The scheduled-tasks database could not be reached."}
        />
      )}
    </>
  );
}
