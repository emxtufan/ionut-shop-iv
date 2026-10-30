import React, { useState, useEffect, useRef } from 'react';
import { Button } from 'antd';
import { FullscreenOutlined, FullscreenExitOutlined, LoadingOutlined } from '@ant-design/icons';
import { PlaybackAuthorization } from '../../types/index.ts';
import { WatermarkOverlay } from './WatermarkOverlay.tsx';

interface SecurePlayerProps {
  videoId: string;
  videoTitle: string;
  posterUrl: string;
  onClose?: () => void;
}

/**
 * Bunny Stream player (MediaCage DRM) inside our container, so the watermark stays on top.
 * Fullscreen is done on our container (the iframe itself is not allowed to go fullscreen),
 * otherwise the watermark would disappear in fullscreen.
 */
export const SecurePlayer: React.FC<SecurePlayerProps> = ({ videoId, videoTitle, onClose }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  const [authData, setAuthData] = useState<PlaybackAuthorization | null>(null);
  const [isLoadingAuth, setIsLoadingAuth] = useState<boolean>(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  // Request playback authorization (signed Bunny embed URL) on mount
  useEffect(() => {
    let isCancelled = false;

    (async () => {
      setIsLoadingAuth(true);
      setAuthError(null);
      try {
        const res = await fetch(`/api/playback/${videoId}/token`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Autorizarea redării a fost respinsă.');
        if (!isCancelled) setAuthData(data);
      } catch (err: any) {
        if (!isCancelled) setAuthError(err.message);
      } finally {
        if (!isCancelled) setIsLoadingAuth(false);
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [videoId]);

  // Heartbeat every 15s; if the account started a stream elsewhere over the limit, stop this one
  useEffect(() => {
    if (!authData) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/playback/${videoId}/heartbeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jti: authData.jti }),
        });
        const data = await res.json();
        if (!data.active) {
          setAuthData(null); // unmounts the iframe, which stops playback
          setAuthError('Redarea a fost întreruptă deoarece contul rulează un alt stream.');
        }
      } catch (e) {
        console.error('Heartbeat failed', e);
      }
    }, 15000);

    return () => {
      clearInterval(interval);
      fetch(`/api/playback/${videoId}/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jti: authData.jti }),
      }).catch(() => {});
    };
  }, [authData, videoId]);

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) containerRef.current?.requestFullscreen().catch(() => {});
    else document.exitFullscreen().catch(() => {});
  };

  return (
    <div
      ref={containerRef}
      className="group relative w-full aspect-video max-h-[calc(100vh-3.5rem)] bg-black overflow-hidden select-none"
    >
      {isLoadingAuth && (
        <div className="absolute inset-0 z-40 bg-black flex flex-col items-center justify-center text-center p-6 space-y-3">
          <LoadingOutlined className="text-2xl text-white" />
          <p className="text-white text-xs font-medium">Inițializare stream securizat...</p>
        </div>
      )}

      {authError && (
        <div className="absolute inset-0 z-40 bg-black/95 flex flex-col items-center justify-center text-center p-8 space-y-4">
          <h3 className="text-base font-semibold text-white">Acces Restricționat</h3>
          <p className="text-neutral-400 max-w-sm text-xs leading-relaxed">{authError}</p>
          {onClose && (
            <Button onClick={onClose} className="text-xs">
              Închide
            </Button>
          )}
        </div>
      )}

      {authData && (
        <>
          <iframe
            src={authData.embedUrl}
            title={videoTitle}
            className="absolute inset-0 w-full h-full border-0"
            allow="accelerometer; gyroscope; autoplay; encrypted-media"
          />

          <WatermarkOverlay
            watermarkText={authData.watermark.text}
            refreshIntervalSeconds={authData.watermark.refreshIntervalSeconds}
          />

          <button
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Ieși din ecran complet' : 'Ecran complet'}
            aria-label={isFullscreen ? 'Ieși din ecran complet' : 'Ecran complet'}
            className="absolute bottom-1.5 right-1.5 z-40 w-9 h-9 rounded bg-black/80 hover:bg-black opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity text-white flex items-center justify-center cursor-pointer"
          >
            {isFullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
          </button>
        </>
      )}
    </div>
  );
};
