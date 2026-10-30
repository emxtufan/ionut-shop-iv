import React, { useState, useEffect } from 'react';
import { Button, Skeleton, Empty } from 'antd';
import { PlayCircleFilled, LockOutlined } from '@ant-design/icons';
import { Video } from '../../types/index.ts';
import { VideoCard } from '../components/VideoCard.tsx';
import { useAuth } from '../context/AuthContext.tsx';

interface CatalogPageProps {
  searchQuery: string;
  // Changes whenever a payment is confirmed: forces the catalog (isPurchased) to reload
  purchasesVersion: number;
  onWatch: (video: Video) => void;
  onUnlock: (video: Video) => void;
}

export const CatalogPage: React.FC<CatalogPageProps> = ({
  searchQuery,
  purchasesVersion,
  onWatch,
  onUnlock,
}) => {
  const { user } = useAuth();
  const [videos, setVideos] = useState<Video[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  // Load videos from backend
  const loadVideos = async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      if (searchQuery) params.append('search', searchQuery);

      const res = await fetch(`/api/videos?${params.toString()}`);
      const data = await res.json();
      setVideos(data.videos || []);
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadVideos();
  }, [searchQuery, user, purchasesVersion]);

  // Featured hero video (first video or first unpurchased/featured)
  const heroVideo = videos.length > 0 ? videos[0] : null;
  const isHeroPurchased = heroVideo ? (heroVideo.isPurchased || heroVideo.hasEntitlement) : false;

  // Sections
  const featuredVideos = videos.slice(0, 4);
  const latestVideos = videos.slice(4);
  const myLibraryVideos = user ? videos.filter((v) => v.isPurchased || v.hasEntitlement) : [];

  if (isLoading) {
    return (
      <div className="max-w-6xl mx-auto px-6 py-8 space-y-12">
        <Skeleton.Node active style={{ width: '100%', height: 420, borderRadius: 20 }} />
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="space-y-3">
              <Skeleton.Button active block style={{ height: 160, borderRadius: 12 }} />
              <Skeleton.Input active size="small" block />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (videos.length === 0) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-20 text-center">
        <Empty
          description={
            <span className="text-muted text-sm">
              {searchQuery ? `Niciun rezultat pentru „${searchQuery}”` : 'Nu există videoclipuri disponibile.'}
            </span>
          }
        />
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-16 animate-in fade-in duration-300">
      {/* 1. Cinematic Hero Section */}
      {heroVideo && !searchQuery && (
        <section className="relative w-full rounded-2xl overflow-hidden bg-cream border border-ink/15 shadow-2xl aspect-[21/9] min-h-[360px] flex items-end">
          {/* Background Poster Image */}
          <img
            src={heroVideo.thumbnailUrl}
            alt={heroVideo.title}
            className="absolute inset-0 w-full h-full object-cover object-center"
          />

          {/* Warm brown vignette so the light text stays readable on any image */}
          <div className="absolute inset-0 bg-gradient-to-t from-ink via-ink/40 to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-r from-ink/80 via-ink/30 to-transparent" />

          {/* Hero Content (on the image: light text) */}
          <div className="relative z-10 p-8 sm:p-12 max-w-2xl space-y-4">
            <h1 className="font-display text-3xl sm:text-5xl font-light tracking-tight text-cream leading-tight">
              {heroVideo.title}
            </h1>
            <p className="text-cream/80 text-sm sm:text-base leading-relaxed line-clamp-2 max-w-xl">
              {heroVideo.description}
            </p>

            <div className="pt-2 flex items-center gap-4">
              {isHeroPurchased ? (
                <Button
                  type="primary"
                  size="large"
                  icon={<PlayCircleFilled />}
                  onClick={() => onWatch(heroVideo)}
                  className="px-6 h-11 text-sm font-semibold rounded-xl !bg-cream !text-ink hover:!bg-gold-light hover:!text-ink border-none"
                >
                  Vizionează
                </Button>
              ) : (
                <div className="flex items-center gap-4">
                  <Button
                    type="primary"
                    size="large"
                    icon={<LockOutlined />}
                    onClick={() => onUnlock(heroVideo)}
                    className="px-6 h-11 text-sm font-semibold rounded-xl !bg-cream !text-ink hover:!bg-gold-light hover:!text-ink border-none"
                  >
                    Deblochează
                  </Button>
                  <span className="text-lg font-medium text-cream/90">
                    {heroVideo.priceAmount} {heroVideo.currency}
                  </span>
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* 2. My Library (if user has active purchases and not in search mode) */}
      {myLibraryVideos.length > 0 && !searchQuery && (
        <section className="space-y-5">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-semibold text-ink tracking-tight">
              Biblioteca mea
            </h2>
            <span className="text-xs text-muted">
              {myLibraryVideos.length} {myLibraryVideos.length === 1 ? 'film' : 'filme'}
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {myLibraryVideos.map((video) => (
              <VideoCard
                key={video.id}
                video={video}
                onWatch={onWatch}
                onUnlock={onUnlock}
              />
            ))}
          </div>
        </section>
      )}

      {/* 3. Featured Section */}
      <section className="space-y-5">
        <h2 className="text-lg font-semibold text-ink tracking-tight">
          Recomandate
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
          {featuredVideos.map((video) => (
            <VideoCard
              key={video.id}
              video={video}
              onWatch={onWatch}
              onUnlock={onUnlock}
            />
          ))}
        </div>
      </section>

      {/* 4. Latest Section */}
      {latestVideos.length > 0 && (
        <section className="space-y-5">
          <h2 className="text-lg font-semibold text-ink tracking-tight">
            Cele mai noi
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {latestVideos.map((video) => (
              <VideoCard
                key={video.id}
                video={video}
                onWatch={onWatch}
                onUnlock={onUnlock}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
