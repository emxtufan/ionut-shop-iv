// ==============================================================================
// IV Concept VOD - Dynamic Forensic & Visible Anti-Piracy Watermark
// ==============================================================================

import React, { useState, useEffect } from 'react';

interface WatermarkOverlayProps {
  watermarkText: string;
  refreshIntervalSeconds?: number;
}

export const WatermarkOverlay: React.FC<WatermarkOverlayProps> = ({
  watermarkText,
  refreshIntervalSeconds = 5,
}) => {
  const [coords, setCoords] = useState<{ top: string; left: string }>({
    top: '15%',
    left: '20%',
  });

  useEffect(() => {
    // Generate jitter coordinates across 6 safe zones to prevent muscle memory screen recording
    const interval = setInterval(() => {
      const topPercent = Math.floor(Math.random() * 70) + 12; // 12% - 82%
      const leftPercent = Math.floor(Math.random() * 65) + 8; // 8% - 73%

      setCoords({
        top: `${topPercent}%`,
        left: `${leftPercent}%`,
      });
    }, refreshIntervalSeconds * 1000);

    return () => clearInterval(interval);
  }, [refreshIntervalSeconds]);

  return (
    <div
      className="absolute inset-0 pointer-events-none select-none overflow-hidden z-30"
      style={{ userSelect: 'none' }}
      aria-hidden="true"
    >
      {/* Dynamic Moving Forensic Watermark: text only, no frame, so it blends into the video */}
      <div
        className="absolute transition-all duration-1000 ease-in-out font-semibold tracking-wide text-xs sm:text-sm text-white/40 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]"
        style={{
          top: coords.top,
          left: coords.left,
        }}
      >
        <span>{watermarkText}</span>
      </div>
    </div>
  );
};
