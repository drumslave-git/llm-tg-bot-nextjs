import { Bug, Database } from "lucide-react";
import Link from "next/link";

import { PageHeader } from "@/components/PageHeader";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
} from "@/components/ui";
import { listUsers } from "@/features/known-users/server/service";
import type { KnownUser } from "@/features/known-users/server/schema";
import { KnownUsersTable } from "@/features/known-users/ui/KnownUsersTable";

// Users are read from the database at request time.
export const dynamic = "force-dynamic";

/**
 * Known-users dashboard page. Server Component: lists every user who has messaged
 * the bot. Aliases are operator-curated inline (Client Component).
 */
export default async function UsersPage() {
  let users: KnownUser[] | null = null;
  let dbError: string | null = null;
  try {
    users = await listUsers();
  } catch (err) {
    dbError = err instanceof Error ? err.message : "Could not read users from the database";
  }

  return (
    <>
      <PageHeader
        title="Known users"
        description="Everyone who has messaged the bot. Curate aliases and pick the owner from this list in Settings."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/users/debug">
              <Bug className="h-4 w-4" aria-hidden />
              Debug
            </Link>
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Users</CardTitle>
            <CardDescription>
              Captured automatically on each message. Aliases are alternate names you add.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {users ? (
            <KnownUsersTable users={users} />
          ) : (
            <EmptyState
              icon={Database}
              title="Database unavailable"
              description={dbError ?? "The users database could not be reached."}
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}
