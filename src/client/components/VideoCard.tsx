import React from 'react';
import { LockOutlined, PlayCircleFilled } from '@ant-design/icons';
import { Video } from '../../types/index.ts';

interface VideoCardProps {
  video: Video;
  onWatch: (video: Video) => void;
  onUnlock: (video: Video) => void;
}

export const VideoCard: React.FC<VideoCardProps> = ({ video, onWatch, onUnlock }) => {
  const isPurchased = video.isPurchased || video.hasEntitlement;

  const handleClick = () => {
    if (isPurchased) {
      onWatch(video);
    } else {
      onUnlock(video);
    }
  };

  return (
    <div
      onClick={handleClick}
      className="group cursor-pointer flex flex-col gap-2.5 transition-all select-none"
    >
      {/* 16:9 Thumbnail Container */}
      <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-cream border border-ink/10 transition-transform duration-300 ease-out group-hover:scale-[1.02]">
        <img
          src={video.thumbnailUrl}
          alt={video.title}
          className="w-full h-full object-cover transition-opacity duration-300 group-hover:opacity-90"
          loading="lazy"
        />

        {/* Minimal subtle gradient at bottom for legibility */}
        <div className="absolute inset-0 bg-gradient-to-t from-ink/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />

        {/* Locked state: discreet, elegant lock icon */}
        {!isPurchased && (
          <div className="absolute top-2.5 right-2.5 w-7 h-7 rounded-full bg-ink/60 backdrop-blur-md flex items-center justify-center text-cream/90 border border-cream/20 shadow-sm">
            <LockOutlined className="text-xs" />
          </div>
        )}

        {/* Purchased state: play glyph on hover */}
        {isPurchased && (
          <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300">
            <div className="w-11 h-11 rounded-full bg-cream/90 text-ink flex items-center justify-center shadow-lg transform transition-transform group-hover:scale-105">
              <PlayCircleFilled className="text-xl translate-x-[1px]" />
            </div>
          </div>
        )}
      </div>

      {/* Under thumbnail: Title & Price / Status */}
      <div className="flex items-start justify-between gap-3 pt-0.5">
        <h3 className="text-sm font-medium text-ink tracking-tight line-clamp-1 group-hover:text-ink-soft transition-colors">
          {video.title}
        </h3>
        <div className="text-xs whitespace-nowrap">
          {isPurchased ? (
            <span className="text-muted font-normal">Cumpărat</span>
          ) : (
            <span className="text-ink/90 font-medium tracking-tight">
              {video.priceAmount} {video.currency}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
