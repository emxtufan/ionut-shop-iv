// ==============================================================================
// IV Concept VOD - Admin: Users Management Tab
// ==============================================================================

import React, { useState, useEffect } from 'react';
import { Table, Input, Tag, Drawer, Button, Popconfirm, Select, message } from 'antd';
import { useAuth } from '../context/AuthContext.tsx';

const PAGE_SIZE = 50;

interface UserRow {
  id: string;
  email: string;
  username: string;
  role: string;
  isSuspended: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  lockoutUntil: string | null;
  _count?: { entitlements: number };
}

interface UserDetails {
  id: string;
  email: string;
  username: string;
  role: string;
  isSuspended: boolean;
  suspendedReason?: string | null;
  failedLoginAttempts?: number;
  lockoutUntil?: string | null;
  lastLoginAt?: string | null;
  lastLoginIp?: string | null;
  createdAt: string;
}

interface EntitlementRow {
  videoId: string;
  videoTitle: string;
  status: string;
  purchaseId: string | null;
  createdAt: string;
}

function formatDate(value?: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('ro-RO');
}

function roleLabel(role: string): string {
  const labels: Record<string, string> = {
    USER: 'Utilizator',
    ADMIN: 'Administrator',
    SUPER_ADMIN: 'Super Admin',
  };
  return labels[role] || role;
}

// Suspended wins over a temporary lockout: a suspended account cannot log in at all
function accountState(user: { isSuspended: boolean; lockoutUntil?: string | null }): [string, string] {
  if (user.isSuspended) return ['red', 'Suspendat'];
  if (user.lockoutUntil && new Date(user.lockoutUntil) > new Date()) return ['orange', 'Blocat temporar'];
  return ['green', 'Activ'];
}

export const AdminUsersTab: React.FC = () => {
  const { user: authUser } = useAuth();
  const isSuperAdmin = authUser?.role === 'SUPER_ADMIN';

  // Table state
  const [rows, setRows] = useState<UserRow[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [page, setPage] = useState<number>(1);
  const [searchInput, setSearchInput] = useState<string>('');
  const [search, setSearch] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);

  // Drawer state
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [details, setDetails] = useState<UserDetails | null>(null);
  const [entitlements, setEntitlements] = useState<EntitlementRow[]>([]);
  const [sessionsCount, setSessionsCount] = useState<number>(0);
  const [isDetailsLoading, setIsDetailsLoading] = useState<boolean>(false);
  const [isActionRunning, setIsActionRunning] = useState<boolean>(false);
  const [videos, setVideos] = useState<{ id: string; title: string }[]>([]);
  const [grantVideoId, setGrantVideoId] = useState<string | undefined>(undefined);

  // Search is debounced so every keystroke doesn't hit the server
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const loadUsers = async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/admin/users?page=${page}&search=${encodeURIComponent(search)}`);
      const data = await res.json();
      if (!res.ok) {
        message.error(data.message || 'Eroare la încărcarea utilizatorilor.');
        return;
      }
      setRows(data.items || []);
      setTotal(data.total || 0);
    } catch {
      message.error('Eroare de conexiune la încărcarea utilizatorilor.');
    } finally {
      setIsLoading(false);
    }
  };

  const loadUserDetails = async (id: string) => {
    setIsDetailsLoading(true);
    try {
      const res = await fetch(`/api/admin/users/${id}`);
      const data = await res.json();
      if (!res.ok) {
        message.error(data.message || 'Eroare la încărcarea contului.');
        return;
      }
      setDetails(data.user);
      setEntitlements(data.entitlements || []);
      setSessionsCount(data.sessionsCount ?? 0);
    } catch {
      message.error('Eroare de conexiune la încărcarea contului.');
    } finally {
      setIsDetailsLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
  }, [page, search]);

  // The grant dropdown needs the full catalog, drafts included
  useEffect(() => {
    fetch('/api/admin/videos')
      .then((r) => r.json())
      .then((d) => setVideos((d.videos || []).map((v: any) => ({ id: v.id, title: v.title }))))
      .catch(() => {});
  }, []);

  const openUser = (id: string) => {
    setSelectedId(id);
    setDetails(null);
    setEntitlements([]);
    setSessionsCount(0);
    setGrantVideoId(undefined);
    loadUserDetails(id);
  };

  const closeDrawer = () => {
    setSelectedId(null);
    setDetails(null);
    setEntitlements([]);
  };

  const runAction = async (url: string, init: RequestInit, successMessage: string): Promise<boolean> => {
    setIsActionRunning(true);
    try {
      const res = await fetch(url, init);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        message.error(data.message || 'Acțiunea a eșuat.');
        return false;
      }
      message.success(successMessage);
      return true;
    } catch {
      message.error('Eroare de conexiune.');
      return false;
    } finally {
      setIsActionRunning(false);
    }
  };

  const refreshAll = async (id: string) => {
    await Promise.all([loadUsers(), loadUserDetails(id)]);
  };

  const handleToggleSuspension = async (target: UserDetails) => {
    const ok = await runAction(
      `/api/admin/users/${target.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isSuspended: !target.isSuspended }),
      },
      target.isSuspended ? 'Contul a fost reactivat.' : 'Contul a fost suspendat.'
    );
    if (ok) await refreshAll(target.id);
  };

  const handleLogoutAll = async (target: UserDetails) => {
    const ok = await runAction(
      `/api/admin/users/${target.id}/logout-all`,
      { method: 'POST' },
      'Utilizatorul a fost deconectat de pe toate dispozitivele.'
    );
    if (ok) await refreshAll(target.id);
  };

  const handleSendPasswordReset = async (target: UserDetails) => {
    await runAction(
      `/api/admin/users/${target.id}/send-password-reset`,
      { method: 'POST' },
      'Emailul de resetare a parolei a fost trimis.'
    );
  };

  const handleRoleChange = async (target: UserDetails, role: string) => {
    const ok = await runAction(
      `/api/admin/users/${target.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      },
      `Rolul a fost schimbat în ${roleLabel(role)}.`
    );
    if (ok) await refreshAll(target.id);
  };

  const handleGrant = async () => {
    if (!details || !grantVideoId) return;
    const ok = await runAction(
      `/api/admin/users/${details.id}/entitlements`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId: grantVideoId }),
      },
      'Accesul a fost acordat.'
    );
    if (!ok) return;
    setGrantVideoId(undefined);
    await refreshAll(details.id);
  };

  const handleRevoke = async (videoId: string) => {
    if (!details) return;
    const ok = await runAction(
      `/api/admin/users/${details.id}/entitlements/${videoId}`,
      { method: 'DELETE' },
      'Accesul a fost revocat.'
    );
    if (ok) await refreshAll(details.id);
  };

  const columns = [
    {
      title: 'Email',
      dataIndex: 'email',
      key: 'email',
      render: (email: string) => <span className="text-xs text-ink">{email}</span>,
    },
    {
      title: 'Utilizator',
      dataIndex: 'username',
      key: 'username',
      render: (username: string) => <span className="text-xs text-ink">{username}</span>,
    },
    {
      title: 'Rol',
      dataIndex: 'role',
      key: 'role',
      width: 140,
      render: (role: string) => (
        <Tag color={role === 'SUPER_ADMIN' ? 'purple' : role === 'ADMIN' ? 'blue' : 'default'}>
          {roleLabel(role)}
        </Tag>
      ),
    },
    {
      title: 'Stare',
      key: 'state',
      width: 160,
      render: (_: any, record: UserRow) => {
        const [color, label] = accountState(record);
        return <Tag color={color}>{label}</Tag>;
      },
    },
    {
      title: 'Data creării',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 180,
      render: (value: string) => <span className="text-xs text-muted">{formatDate(value)}</span>,
    },
    {
      title: 'Ultima autentificare',
      dataIndex: 'lastLoginAt',
      key: 'lastLoginAt',
      width: 180,
      render: (value: string | null) => <span className="text-xs text-muted">{formatDate(value)}</span>,
    },
    {
      title: 'Filme active',
      key: 'activeVideos',
      width: 120,
      render: (_: any, record: UserRow) => (
        <span className="text-xs font-semibold text-ink">{record._count?.entitlements ?? 0}</span>
      ),
    },
  ];

  // Nobody can act on their own account; a SUPER_ADMIN account is only reachable by a SUPER_ADMIN
  const canAct = !!details && details.id !== authUser?.id && (details.role !== 'SUPER_ADMIN' || isSuperAdmin);
  const canChangeRole = !!details && canAct && isSuperAdmin && details.role !== 'SUPER_ADMIN';
  const [stateColor, stateLabel] = details ? accountState(details) : ['default', '—'];

  const infoRow = (label: string, value: React.ReactNode) => (
    <div className="flex items-start justify-between gap-4">
      <span className="text-muted shrink-0">{label}</span>
      <span className="text-ink font-medium text-right break-all">{value}</span>
    </div>
  );

  return (
    <div className="pt-2 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <Input
          allowClear
          placeholder="Caută după email sau utilizator"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="max-w-xs"
        />
        <span className="text-xs text-muted">{total} utilizatori</span>
      </div>

      <Table
        dataSource={rows}
        columns={columns}
        rowKey="id"
        loading={isLoading}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total,
          showSizeChanger: false,
          showTotal: (count: number) => `${count} utilizatori`,
        }}
        onChange={(pagination) => setPage(pagination.current || 1)}
        onRow={(record: UserRow) => ({
          onClick: () => openUser(record.id),
          style: { cursor: 'pointer' },
        })}
        className="border border-ink/10 rounded-xl overflow-hidden"
      />

      <Drawer
        title="Detalii cont"
        open={selectedId !== null}
        onClose={closeDrawer}
        width={560}
        destroyOnHidden
      >
        {isDetailsLoading && !details && (
          <p className="text-xs text-muted">Se încarcă datele contului...</p>
        )}

        {details && (
          <div className="space-y-6">
            {/* Account details */}
            <div className="p-4 rounded-xl bg-cream border border-ink/10 space-y-2 text-xs">
              {infoRow('Email', details.email)}
              {infoRow('Utilizator', details.username)}
              {infoRow('Rol', roleLabel(details.role))}
              {infoRow(
                'Stare',
                <Tag color={stateColor}>{stateLabel}</Tag>
              )}
              {infoRow('Data creării', formatDate(details.createdAt))}
              {infoRow('Ultima autentificare', formatDate(details.lastLoginAt))}
              {infoRow('IP ultima autentificare', details.lastLoginIp || '—')}
              {infoRow('Sesiuni active', String(sessionsCount))}
              {infoRow('Încercări eșuate', String(details.failedLoginAttempts ?? 0))}
              {details.lockoutUntil && infoRow('Blocat până la', formatDate(details.lockoutUntil))}
              {details.suspendedReason && infoRow('Motiv suspendare', details.suspendedReason)}
            </div>

            {/* Account actions */}
            {canAct && (
              <div className="space-y-3">
                <h4 className="text-xs font-semibold text-ink">Acțiuni cont</h4>

                <Popconfirm
                  title={details.isSuspended ? 'Reactivezi acest cont?' : 'Suspenzi acest cont?'}
                  description={
                    details.isSuspended
                      ? 'Utilizatorul se va putea autentifica din nou.'
                      : 'Toate sesiunile active vor fi închise.'
                  }
                  okText={details.isSuspended ? 'Reactivează' : 'Suspendă'}
                  cancelText="Anulează"
                  okButtonProps={{ danger: !details.isSuspended }}
                  onConfirm={() => handleToggleSuspension(details)}
                >
                  <Button danger={!details.isSuspended} disabled={isActionRunning} block>
                    {details.isSuspended ? 'Reactivează' : 'Suspendă'}
                  </Button>
                </Popconfirm>

                <Popconfirm
                  title="Deconectezi utilizatorul de peste tot?"
                  description="Toate sesiunile sunt șterse, iar blocarea temporară a contului este ridicată."
                  okText="Deconectează"
                  cancelText="Anulează"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => handleLogoutAll(details)}
                >
                  <Button disabled={isActionRunning} block>
                    Deconectează de pe toate dispozitivele
                  </Button>
                </Popconfirm>

                <Popconfirm
                  title="Trimiți emailul de resetare a parolei?"
                  description={`Se trimite un link de resetare către ${details.email}.`}
                  okText="Trimite"
                  cancelText="Anulează"
                  onConfirm={() => handleSendPasswordReset(details)}
                >
                  <Button disabled={isActionRunning} block>
                    Trimite email de resetare parolă
                  </Button>
                </Popconfirm>
              </div>
            )}

            {/* Role change - SUPER_ADMIN only */}
            {canChangeRole && (
              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-ink">Rol</h4>
                <Select
                  value={details.role === 'ADMIN' ? 'ADMIN' : 'USER'}
                  options={[
                    { value: 'USER', label: 'Utilizator' },
                    { value: 'ADMIN', label: 'Administrator' },
                  ]}
                  onChange={(role) => handleRoleChange(details, role)}
                  disabled={isActionRunning}
                  className="w-full"
                />
              </div>
            )}

            {/* Entitlements */}
            <div className="space-y-3">
              <h4 className="text-xs font-semibold text-ink">Filme acces ({entitlements.length})</h4>

              {entitlements.length === 0 ? (
                <p className="text-xs text-muted">Utilizatorul nu are niciun film în bibliotecă.</p>
              ) : (
                <div className="space-y-2">
                  {entitlements.map((entitlement) => (
                    <div
                      key={entitlement.videoId}
                      className="flex items-center justify-between gap-3 p-3 rounded-xl bg-cream/70 border border-ink/10"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium text-ink truncate">{entitlement.videoTitle}</div>
                        <div className="flex items-center gap-2 mt-1">
                          <Tag color={entitlement.status === 'ACTIVE' ? 'green' : 'default'}>
                            {entitlement.status === 'ACTIVE' ? 'Activ' : 'Revocat'}
                          </Tag>
                          <Tag color={entitlement.purchaseId ? 'blue' : 'gold'}>
                            {entitlement.purchaseId ? 'Cumpărat' : 'Manual'}
                          </Tag>
                        </div>
                      </div>

                      {canAct && (
                        <Popconfirm
                          title="Revoci accesul la acest film?"
                          description="Cumpărarea rămâne în istoric, doar accesul este închis."
                          okText="Revocă"
                          cancelText="Anulează"
                          okButtonProps={{ danger: true }}
                          onConfirm={() => handleRevoke(entitlement.videoId)}
                        >
                          <Button type="text" size="small" danger disabled={isActionRunning}>
                            Revocă
                          </Button>
                        </Popconfirm>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Manual grant */}
            {canAct && (
              <div className="space-y-2 pt-3 border-t border-ink/10">
                <h4 className="text-xs font-semibold text-ink">Acordă acces</h4>
                <div className="flex items-end gap-2">
                  <Select
                    showSearch
                    optionFilterProp="label"
                    placeholder="Alege un film"
                    value={grantVideoId}
                    onChange={(value) => setGrantVideoId(value)}
                    options={videos.map((video) => ({ value: video.id, label: video.title }))}
                    className="flex-1"
                  />
                  <Button
                    type="primary"
                    disabled={!grantVideoId || isActionRunning}
                    onClick={handleGrant}
                    className="bg-ink text-cream hover:!bg-ink-soft hover:!text-cream border-none text-xs font-medium"
                  >
                    Acordă acces
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
};
