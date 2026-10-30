import React, { useState, useEffect } from 'react';
import { Button, Skeleton, Empty } from 'antd';
import { PlayCircleFilled, CompassOutlined } from '@ant-design/icons';
import { Video } from '../../types/index.ts';
import { VideoCard } from '../components/VideoCard.tsx';
import { useAuth } from '../context/AuthContext.tsx';

interface LibraryPageProps {
  // Changes whenever a payment is confirmed: forces the library to reload
  purchasesVersion: number;
  onWatch: (video: Video) => void;
  onExploreCatalog: () => void;
}

export const LibraryPage: React.FC<LibraryPageProps> = ({
  purchasesVersion,
  onWatch,
  onExploreCatalog,
}) => {
  const { user } = useAuth();
  const [libraryVideos, setLibraryVideos] = useState<Video[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  useEffect(() => {
    if (!user) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);

    fetch('/api/library')
      .then((res) => res.json())
      .then((data) => setLibraryVideos(data.library || []))
      .catch((e) => console.error(e))
      .finally(() => setIsLoading(false));
  }, [user, purchasesVersion]);

  if (!user) {
    return (
      <div className="max-w-xl mx-auto px-6 py-28 text-center space-y-4">
        <h2 className="text-2xl font-semibold text-ink tracking-tight">Your Library</h2>
        <p className="text-sm text-muted">
          Autentifică-te pentru a accesa colecția ta personală de masterclass-uri.
        </p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        <div className="h-8 w-40 bg-cream rounded-lg animate-pulse" />
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
          {[1, 2, 3].map((i) => (
            <div key={i} className="space-y-3">
              <Skeleton.Button active block style={{ height: 160, borderRadius: 12 }} />
              <Skeleton.Input active size="small" block />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-8 animate-in fade-in duration-300">
      <div className="flex items-baseline justify-between border-b border-ink/10 pb-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink tracking-tight">
            Library
          </h1>
          <p className="text-xs text-muted mt-1">
            {libraryVideos.length} {libraryVideos.length === 1 ? 'film deblocat' : 'filme deblocate'} în contul tău
          </p>
        </div>
      </div>

      {libraryVideos.length === 0 ? (
        <div className="py-24 text-center max-w-md mx-auto space-y-5">
          <Empty
            description={
              <span className="text-muted text-sm">
                Nu ai niciun videoclip în bibliotecă încă.
              </span>
            }
          />
          <Button
            type="primary"
            onClick={onExploreCatalog}
            className="rounded-xl px-5 h-10 font-medium text-xs bg-ink text-cream hover:!bg-ink-soft hover:!text-cream border-none"
          >
            Explore Catalog
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
          {libraryVideos.map((video) => (
            <VideoCard
              key={video.id}
              video={{ ...video, isPurchased: true, hasEntitlement: true }}
              onWatch={onWatch}
              onUnlock={onWatch}
            />
          ))}
        </div>
      )}
    </div>
  );
};
