"use client";

import { MessageSquareHeart, SlidersHorizontal, Wand2 } from "lucide-react";

import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  type BadgeTone,
} from "@/components/ui";
import { useLiveRefresh } from "@/components/realtime/useLiveRefresh";
import { Timestamp } from "@/components/time/Timestamp";
import type {
  SelfImprovementView,
  UserFeedbackView,
} from "@/features/self-improvement/server/service";
import type { FeedbackStatus } from "@/features/self-improvement/types";

const STATUS_LABEL: Record<FeedbackStatus, string> = {
  pending: "Awaiting choice",
  awaiting_text: "Awaiting reply",
  completed: "Completed",
};

const STATUS_TONE: Record<FeedbackStatus, BadgeTone> = {
  pending: "warning",
  awaiting_text: "info",
  completed: "success",
};

/**
 * The bot's own account of why the exchange went the way it did, shown under the
 * words the user actually said. Absent until the reflection lands — it is written
 * outside the answer, and the daily job retries any that failed.
 */
function Reflection({ feedback }: { feedback: UserFeedbackView }) {
  if (!feedback.reflection) return null;
  return (
    <p className="whitespace-pre-wrap text-xs text-muted">
      <span className="font-medium">Reflection: </span>
      {feedback.reflection}
    </p>
  );
}

function IncorporationBadges({ feedback }: { feedback: UserFeedbackView }) {
  if (feedback.prefsVersion == null && feedback.correctionsVersion == null) {
    return <span className="text-muted">—</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {feedback.prefsVersion != null ? (
        <Badge tone="primary">prefs v{feedback.prefsVersion}</Badge>
      ) : null}
      {feedback.correctionsVersion != null ? (
        <Badge tone="info">corr v{feedback.correctionsVersion}</Badge>
      ) : null}
    </span>
  );
}

/**
 * The self-improvement dashboard body: collected feedbacks, the latest learned
 * preferences per user, and the latest global self-correction. Client Component
 * only for the live SSE refresh — all data arrives server-rendered via props.
 */
export function SelfImprovementPanel({ view }: { view: SelfImprovementView }) {
  useLiveRefresh("feedback");
  const { feedbacks, preferences, correction } = view;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="space-y-1">
            <CardTitle>Feedback</CardTitle>
            <CardDescription>
              Answers collected from 👍/👎 reactions on the bot&apos;s replies, each with the
              bot&apos;s own reflection on what went right or wrong and why.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {feedbacks.length === 0 ? (
            <EmptyState
              icon={MessageSquareHeart}
              title="No feedback yet"
              description="When someone reacts to a bot reply with 👍 or 👎, their answer shows up here. In groups, Telegram only delivers reactions when the bot is an admin."
            />
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>When</TableHeaderCell>
                  <TableHeaderCell>User</TableHeaderCell>
                  <TableHeaderCell>Reaction</TableHeaderCell>
                  <TableHeaderCell>Feedback</TableHeaderCell>
                  <TableHeaderCell>Model</TableHeaderCell>
                  <TableHeaderCell>Incorporated</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {feedbacks.map((feedback) => (
                  <TableRow key={feedback.id}>
                    <TableCell className="whitespace-nowrap text-muted">
                      <Timestamp iso={feedback.createdAt} />
                    </TableCell>
                    <TableCell>{feedback.userLabel}</TableCell>
                    <TableCell>
                      <Badge tone={feedback.reaction === "up" ? "success" : "danger"}>
                        {feedback.reaction === "up" ? "👍" : "👎"}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-md">
                      {feedback.feedback ? (
                        <div className="space-y-1">
                          <span className="whitespace-pre-wrap">{feedback.feedback}</span>
                          <Reflection feedback={feedback} />
                        </div>
                      ) : (
                        <Badge tone={STATUS_TONE[feedback.status]}>
                          {STATUS_LABEL[feedback.status]}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted">{feedback.model}</TableCell>
                    <TableCell>
                      <IncorporationBadges feedback={feedback} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="space-y-1">
            <CardTitle>Communication preferences</CardTitle>
            <CardDescription>
              The latest learned likes/dislikes per user — injected into every reply to that
              person.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {preferences.length === 0 ? (
            <EmptyState
              icon={SlidersHorizontal}
              title="No preferences yet"
              description="The daily job distills completed feedback into per-user preferences."
            />
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>User</TableHeaderCell>
                  <TableHeaderCell>Likes</TableHeaderCell>
                  <TableHeaderCell>Dislikes</TableHeaderCell>
                  <TableHeaderCell>Version</TableHeaderCell>
                  <TableHeaderCell>Model</TableHeaderCell>
                  <TableHeaderCell>Updated</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {preferences.map((preference) => (
                  <TableRow key={preference.id}>
                    <TableCell className="whitespace-nowrap">{preference.userLabel}</TableCell>
                    <TableCell className="max-w-sm whitespace-pre-wrap">
                      {preference.likes || <span className="text-muted">—</span>}
                    </TableCell>
                    <TableCell className="max-w-sm whitespace-pre-wrap">
                      {preference.dislikes || <span className="text-muted">—</span>}
                    </TableCell>
                    <TableCell>
                      <Badge tone="primary">v{preference.version}</Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted">
                      {preference.model}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted">
                      <Timestamp iso={preference.createdAt} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              Self-corrections
              {correction ? <Badge tone="primary">v{correction.version}</Badge> : null}
            </CardTitle>
            <CardDescription>
              Global guidelines distilled from feedback across all users — composed into the
              system prompt on every reply.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {correction ? (
            <div className="space-y-2">
              <p className="whitespace-pre-wrap text-sm">{correction.correction}</p>
              <p className="text-xs text-muted">
                {correction.model} · <Timestamp iso={correction.createdAt} />
              </p>
            </div>
          ) : (
            <EmptyState
              icon={Wand2}
              title="No corrections yet"
              description="The daily job distills common complaints and praise into correction guidelines."
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
