import React, { useState } from 'react';
import { Button, Dropdown, Input, MenuProps } from 'antd';
import {
  SearchOutlined,
  UserOutlined,
  LogoutOutlined,
  SettingOutlined,
  CheckOutlined,
  CompassOutlined,
  FolderOutlined,
} from '@ant-design/icons';
import { useAuth } from '../context/AuthContext.tsx';

interface NavbarProps {
  currentTab: string;
  onTabChange: (tab: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onOpenAuth: () => void;
  onOpenAdmin?: () => void;
  isAdminMode?: boolean;
  onExitAdmin?: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentTab,
  onTabChange,
  searchQuery,
  onSearchChange,
  onOpenAuth,
  onOpenAdmin,
  isAdminMode = false,
  onExitAdmin,
}) => {
  const { user, logout } = useAuth();
  const [showSearchInput, setShowSearchInput] = useState<boolean>(false);

  const isStaff = user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN';

  const accountMenuItems: MenuProps['items'] = [
    {
      key: 'user-info',
      disabled: true,
      label: (
        <div className="py-1">
          <div className="text-xs font-semibold text-ink">{user?.username}</div>
          <div className="text-[11px] text-muted">{user?.email}</div>
          <div className="mt-1 text-[10px] uppercase font-mono tracking-wider text-muted">
            {user?.role}
          </div>
        </div>
      ),
    },
    { type: 'divider' },
    ...(isStaff
      ? [
          {
            key: 'toggle-admin',
            icon: <SettingOutlined />,
            label: isAdminMode ? 'Înapoi la Cinema' : 'Administrare studio',
            onClick: () => {
              if (isAdminMode && onExitAdmin) {
                onExitAdmin();
              } else if (onOpenAdmin) {
                onOpenAdmin();
              }
            },
          },
          { type: 'divider' as const },
        ]
      : []),
    {
      key: 'purchases',
      icon: <FolderOutlined />,
      label: 'Istoric comenzi',
      onClick: () => onTabChange('purchases'),
    },
    { type: 'divider' },
    {
      key: 'logout',
      danger: true,
      icon: <LogoutOutlined />,
      label: 'Deconectare',
      onClick: logout,
    },
  ];

  return (
    <header className="sticky top-0 z-40 h-16 bg-sand/85 backdrop-blur-xl border-b border-ink/10 transition-colors">
      <div className="max-w-7xl mx-auto h-full px-6 flex items-center justify-between gap-6">
        {/* Left: Brand + Primary Navigation */}
        <div className="flex items-center gap-4 sm:gap-8">
          <button
            onClick={() => {
              if (isAdminMode && onExitAdmin) {
                onExitAdmin();
              }
              onTabChange('catalog');
            }}
            className="flex items-center gap-2.5 text-left group cursor-pointer focus:outline-none"
          >
            <img
              src="/logo.png"
              alt="IV Concept"
              className="w-9 h-9 rounded-full shadow-sm transition-transform group-hover:scale-95"
            />
            <div className="flex items-baseline gap-1.5">
              <span className="font-display font-light text-lg tracking-tight text-ink group-hover:text-ink-soft transition-colors">
                IV Concept
              </span>
              {isAdminMode && (
                <span className="text-[10px] tracking-widest uppercase font-mono px-1.5 py-0.2 rounded bg-ink/10 text-ink/80 border border-ink/20">
                  Studio
                </span>
              )}
            </div>
          </button>

          {!isAdminMode && (
            <nav className="flex items-center gap-1 sm:gap-2">
              <button
                onClick={() => onTabChange('catalog')}
                className={`px-2 sm:px-3.5 py-1.5 rounded-lg text-[13px] sm:text-sm whitespace-nowrap transition-all cursor-pointer ${
                  currentTab === 'catalog'
                    ? 'text-ink font-medium bg-ink/[0.06]'
                    : 'text-muted hover:text-ink hover:bg-ink/[0.04]'
                }`}
              >
                Explorează
              </button>
              <button
                onClick={() => onTabChange('library')}
                className={`px-2 sm:px-3.5 py-1.5 rounded-lg text-[13px] sm:text-sm whitespace-nowrap transition-all cursor-pointer ${
                  currentTab === 'library'
                    ? 'text-ink font-medium bg-ink/[0.06]'
                    : 'text-muted hover:text-ink hover:bg-ink/[0.04]'
                }`}
              >
                <span className="hidden sm:inline">Biblioteca mea</span>
                <span className="sm:hidden">Biblioteca</span>
              </button>
            </nav>
          )}
        </div>

        {/* Right: Search + Account */}
        <div className="flex items-center gap-3">
          {/* Search Bar */}
          {!isAdminMode && (
            <div className="relative">
              {showSearchInput ? (
                <Input
                  prefix={<SearchOutlined className="text-muted/80 mr-1" />}
                  placeholder="Căutare masterclass..."
                  value={searchQuery}
                  onChange={(e) => onSearchChange(e.target.value)}
                  onBlur={() => {
                    if (!searchQuery) setShowSearchInput(false);
                  }}
                  autoFocus
                  allowClear
                  className="w-48 sm:w-64"
                />
              ) : (
                <Button
                  type="text"
                  icon={<SearchOutlined className="text-base text-muted" />}
                  onClick={() => setShowSearchInput(true)}
                  className="text-muted hover:text-ink hover:bg-ink/[0.06] rounded-full"
                  aria-label="Căutare"
                />
              )}
            </div>
          )}

          {/* Admin Switcher Indicator */}
          {isStaff && !isAdminMode && (
            <Button
              type="text"
              onClick={onOpenAdmin}
              className="hidden md:inline-flex items-center gap-1.5 text-xs text-muted hover:text-ink hover:bg-ink/[0.06] px-3 rounded-lg"
            >
              <SettingOutlined />
              <span>Administrare</span>
            </Button>
          )}

          {isAdminMode && (
            <Button
              type="default"
              onClick={onExitAdmin}
              className="text-xs font-medium rounded-lg"
            >
              Înapoi la Cinema
            </Button>
          )}

          {/* Account Menu */}
          {user ? (
            <Dropdown
              menu={{ items: accountMenuItems }}
              trigger={['click']}
              placement="bottomRight"
              arrow
            >
              <button className="flex items-center gap-2 p-1 pl-2.5 rounded-full bg-ink/[0.05] hover:bg-ink/[0.08] border border-ink/15 transition-all cursor-pointer focus:outline-none">
                <span className="text-xs font-medium text-ink hidden sm:inline max-w-[120px] truncate">
                  {user.username}
                </span>
                <div className="w-7 h-7 rounded-full bg-ink/10 text-ink flex items-center justify-center text-xs font-semibold uppercase">
                  {user.username[0]}
                </div>
              </button>
            </Dropdown>
          ) : (
            <Button
              type="primary"
              onClick={onOpenAuth}
              className="font-medium text-xs px-3 sm:px-4 whitespace-nowrap"
            >
              Autentificare
            </Button>
          )}
        </div>
      </div>
    </header>
  );
};
