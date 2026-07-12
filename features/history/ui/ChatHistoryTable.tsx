import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@/components/ui";
import { formatTimestamp } from "@/lib/format";
import type { ChatMessageView } from "../server/schema";

/**
 * Read-only mirror of one chat's stored messages, oldest first. Shows the full
 * captured metadata (Telegram ids, reply pointer, timestamps) and flags edited
 * and deleted rows. Server Component — no interactivity.
 */
export function ChatHistoryTable({
  chatId,
  messages,
}: {
  chatId: string;
  messages: ChatMessageView[];
}) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="font-mono text-base">{chatId}</CardTitle>
          <CardDescription>
            {messages.length} stored message{messages.length === 1 ? "" : "s"}, newest first.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <Table minWidth={860}>
          <TableHead>
            <TableRow header>
              <TableHeaderCell>Sent</TableHeaderCell>
              <TableHeaderCell>Msg</TableHeaderCell>
              <TableHeaderCell>Role</TableHeaderCell>
              <TableHeaderCell>Sender</TableHeaderCell>
              <TableHeaderCell>Reply→</TableHeaderCell>
              <TableHeaderCell>Content</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {messages.map((m) => (
              <TableRow key={m.id}>
                <TableCell className="whitespace-nowrap text-xs text-faint">
                  {formatTimestamp(m.sentAt)}
                </TableCell>
                <TableCell className="font-mono text-xs text-faint">{m.telegramMessageId}</TableCell>
                <TableCell>
                  <Badge tone={m.role === "assistant" ? "primary" : "neutral"}>{m.role}</Badge>
                </TableCell>
                <TableCell className="font-mono text-xs text-muted">{m.userId ?? "—"}</TableCell>
                <TableCell className="font-mono text-xs text-faint">
                  {m.replyToMessageId ?? "—"}
                </TableCell>
                <TableCell className="max-w-[36rem] align-top">
                  <span
                    className={m.deletedAt ? "text-faint line-through" : "text-foreground"}
                  >
                    {m.content}
                  </span>
                  <span className="ml-2 inline-flex gap-1 align-middle">
                    {m.editedAt ? (
                      <Badge tone="warning">edited</Badge>
                    ) : null}
                    {m.deletedAt ? <Badge tone="danger">deleted</Badge> : null}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
