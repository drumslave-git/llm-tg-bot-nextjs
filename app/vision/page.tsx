import { Bug, Database } from "lucide-react";
import Link from "next/link";

import { Button, EmptyState, PageHeader } from "@/components/ui";
import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import { featureDebugHref } from "@/lib/features";
import { listMedia } from "@/features/vision/server/service";
import type { MediaView } from "@/features/vision/types";
import { MediaGallery } from "@/features/vision/ui/MediaGallery";

// Media is read from the database at request time.
export const dynamic = "force-dynamic";

/**
 * Vision dashboard page. Server Component: shows the media the bot has received,
 * with pending images and their descriptions once captioned.
 */
export default async function VisionPage() {
  let media: MediaView[] | null = null;
  let dbError: string | null = null;
  try {
    media = await listMedia();
  } catch (err) {
    dbError = err instanceof Error ? err.message : "Could not read media from the database";
  }

  return (
    <>
      <PageHeader
        title="Vision"
        description="Images and stickers the bot has received. Media on an answered message is read by the model and described to text."
        actions={
          <div className="flex items-center gap-2">
            <LiveIndicator topic="vision" />
            <Button asChild variant="outline" size="sm">
              <Link href={featureDebugHref("vision")}>
                <Bug className="h-4 w-4" aria-hidden />
                Debug
              </Link>
            </Button>
          </div>
        }
      />

      {media ? (
        <MediaGallery media={media} />
      ) : (
        <EmptyState
          icon={Database}
          title="Database unavailable"
          description={dbError ?? "The media database could not be reached."}
        />
      )}
    </>
  );
}
