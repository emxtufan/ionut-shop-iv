import React, { useState, useEffect } from 'react';
import { ConfigProvider, notification } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { brandTheme } from './client/theme.ts';
import { AuthProvider, useAuth } from './client/context/AuthContext.tsx';
import { Navbar } from './client/components/Navbar.tsx';
import { CatalogPage } from './client/pages/CatalogPage.tsx';
import { LibraryPage } from './client/pages/LibraryPage.tsx';
import { PurchasesPage } from './client/pages/PurchasesPage.tsx';
import { AdminDashboardPage } from './client/pages/AdminDashboardPage.tsx';
import { LegalPage, type CompanyInfo, type LegalPageKey } from './client/pages/LegalPage.tsx';
import { SecurePlayer } from './client/components/SecurePlayer.tsx';
import { CheckoutModal } from './client/components/CheckoutModal.tsx';
import { AuthModal } from './client/components/AuthModal.tsx';
import { ResetPasswordModal } from './client/components/ResetPasswordModal.tsx';
import { Video } from './types/index.ts';

// ?page=terms|privacy|cookies renders a legal page instead of the main content
function readLegalPage(): LegalPageKey | null {
  const page = new URLSearchParams(window.location.search).get('page');
  return page === 'terms' || page === 'privacy' || page === 'cookies' ? page : null;
}

function SiteFooter() {
  const [company, setCompany] = useState<CompanyInfo | null>(null);

  useEffect(() => {
    fetch('/api/public/company')
      .then((res) => res.json())
      .then((data: CompanyInfo) => setCompany(data))
      .catch((e) => console.error(e));
  }, []);

  const linkClass = 'hover:text-ink transition-colors';

  return (
    <footer className="border-t border-ink/10">
      <div className="max-w-7xl mx-auto px-6 py-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-[11px] text-muted">
        <nav className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
          <a href="/?page=terms" className={linkClass}>
            Termeni
          </a>
          <a href="/?page=privacy" className={linkClass}>
            Confidențialitate
          </a>
          <a href="/?page=cookies" className={linkClass}>
            Cookies
          </a>
          <a
            href="https://anpc.ro/ce-este-sal/"
            target="_blank"
            rel="noopener noreferrer"
            className={linkClass}
          >
            ANPC SAL
          </a>
        </nav>
        <span className="text-center sm:text-right">
          © {new Date().getFullYear()} {company?.name || '…'}
          {company?.cif ? ` · CIF ${company.cif}` : ''}
        </span>
      </div>
    </footer>
  );
}

function AppContent() {
  const { user } = useAuth();
  const [currentTab, setCurrentTab] = useState<string>('catalog');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isAdminMode, setIsAdminMode] = useState<boolean>(false);
  const [legalPage, setLegalPage] = useState<LegalPageKey | null>(() => readLegalPage());

  // Modals
  const [activeWatchVideo, setActiveWatchVideo] = useState<Video | null>(null);
  const [activeCheckoutVideo, setActiveCheckoutVideo] = useState<Video | null>(null);
  const [showAuthModal, setShowAuthModal] = useState<boolean>(false);
  const [resetToken, setResetToken] = useState<string | null>(null);

  // Check for password reset link redirect (?resetToken=...)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('resetToken');

    if (token) {
      // Clean query params from address bar
      window.history.replaceState({}, '', window.location.pathname);
      setResetToken(token);
    }
  }, []);

  // Check for Stripe Checkout return redirect (?stripe_payment=success&session_id=...)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const stripePayment = params.get('stripe_payment');
    const sessionId = params.get('session_id');
    const videoId = params.get('video_id');

    if (stripePayment === 'success' && sessionId) {
      // Clean query params from address bar
      window.history.replaceState({}, '', window.location.pathname);

      fetch('/api/payments/verify-stripe-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.success) {
            notification.success({
              message: 'Plată Stripe confirmată!',
              description: 'Accesul a fost activat permanent în contul tău.',
              placement: 'bottomRight',
            });
            // Fetch video to launch player
            if (videoId) {
              fetch(`/api/videos/${videoId}`)
                .then((vr) => vr.json())
                .then((vd) => {
                  if (vd.id) setActiveWatchVideo(vd);
                })
                .catch(() => {});
            }
          } else {
            notification.warning({
              message: 'Verificare plată',
              description: data.message || 'Tranzacția este în curs de confirmare.',
              placement: 'bottomRight',
            });
          }
        })
        .catch(() => {
          notification.error({
            message: 'Eroare',
            description: 'Nu s-a putut verifica sesiunea de plată.',
          });
        });
    } else if (stripePayment === 'cancelled') {
      window.history.replaceState({}, '', window.location.pathname);
      notification.info({
        message: 'Plată anulată',
        description: 'Sesiunea Stripe Checkout a fost anulată.',
        placement: 'bottomRight',
      });
    }
  }, []);

  const handleWatch = (video: Video) => {
    if (!user) {
      setShowAuthModal(true);
      return;
    }
    setActiveWatchVideo(video);
  };

  const handleUnlock = (video: Video) => {
    if (!user) {
      setShowAuthModal(true);
      return;
    }
    setActiveCheckoutVideo(video);
  };

  return (
    <div className="min-h-screen bg-sand text-ink flex flex-col font-sans selection:bg-ink selection:text-cream">
      {/* Sleek 64px Header */}
      <Navbar
        currentTab={currentTab}
        onTabChange={(tab) => {
          setIsAdminMode(false);
          setCurrentTab(tab);
          // Leaving a legal page (?page=...) goes back to the catalog
          if (legalPage) {
            window.history.replaceState({}, '', '/');
            setLegalPage(null);
          }
        }}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onOpenAuth={() => setShowAuthModal(true)}
        isAdminMode={isAdminMode}
        onOpenAdmin={() => setIsAdminMode(true)}
        onExitAdmin={() => setIsAdminMode(false)}
      />

      {/* Main Content Area (No Desktop Sidebar in Client Mode) */}
      <main className="flex-1 w-full pb-16">
        {legalPage ? (
          <>
            <div className="max-w-3xl mx-auto px-6 pt-8">
              <a
                href="/"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-muted hover:text-ink transition-colors"
              >
                <ArrowLeftOutlined className="text-[10px]" />
                Înapoi la catalog
              </a>
            </div>
            <LegalPage page={legalPage} />
          </>
        ) : isAdminMode ? (
          <AdminDashboardPage onExitAdmin={() => setIsAdminMode(false)} />
        ) : (
          <>
            {currentTab === 'catalog' && (
              <CatalogPage
                searchQuery={searchQuery}
                onWatch={handleWatch}
                onUnlock={handleUnlock}
              />
            )}

            {currentTab === 'library' && (
              <LibraryPage
                onWatch={handleWatch}
                onExploreCatalog={() => setCurrentTab('catalog')}
              />
            )}

            {currentTab === 'purchases' && <PurchasesPage />}
          </>
        )}
      </main>

      {/* Footer on all content pages, hidden in admin and under the player overlay */}
      {!isAdminMode && !activeWatchVideo && <SiteFooter />}

      {/* Active Secure Video Player View */}
      {activeWatchVideo && (
        <div className="fixed inset-0 z-50 bg-black overflow-y-auto">
          {/* Minimalist Top Bar */}
          <div className="h-14 flex items-center gap-3 px-4 bg-black text-white">
            <span className="w-2 h-2 rounded-full bg-gold shrink-0" />
            <h3 className="flex-1 min-w-0 font-medium text-sm truncate">
              {activeWatchVideo.title}
            </h3>
            <button
              onClick={() => setActiveWatchVideo(null)}
              className="shrink-0 text-xs font-medium text-white/70 hover:text-white px-2.5 py-1 rounded-lg hover:bg-white/10 transition-colors cursor-pointer"
            >
              Închide
            </button>
          </div>

          {/* Video Player */}
          <SecurePlayer
            videoId={activeWatchVideo.id}
            videoTitle={activeWatchVideo.title}
            posterUrl={activeWatchVideo.thumbnailUrl}
            onClose={() => setActiveWatchVideo(null)}
          />
        </div>
      )}

      {/* Checkout Modal */}
      {activeCheckoutVideo && (
        <CheckoutModal
          video={activeCheckoutVideo}
          onClose={() => setActiveCheckoutVideo(null)}
        />
      )}

      {/* Reset Password Modal (from email link ?resetToken=...) */}
      {resetToken && (
        <ResetPasswordModal
          token={resetToken}
          onClose={() => setResetToken(null)}
          onSuccess={(message) => {
            setResetToken(null);
            notification.success({
              message: 'Parolă actualizată',
              description: message,
              placement: 'bottomRight',
            });
            setShowAuthModal(true);
          }}
        />
      )}

      {/* Authentication Modal */}
      {showAuthModal && (
        <AuthModal
          initialMode="login"
          onClose={() => setShowAuthModal(false)}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <ConfigProvider theme={brandTheme}>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </ConfigProvider>
  );
}
