// ==============================================================================
// IV Concept VOD - Admin: Invoices (FGO) Tab
// ==============================================================================

import React, { useState, useEffect } from 'react';
import { Table, Tag, Button, Popconfirm, Select, Alert, message } from 'antd';
import { useAuth } from '../context/AuthContext.tsx';

const PAGE_SIZE = 20;

const STATUS_FILTERS = [
  { value: 'ALL', label: 'Toate stările' },
  { value: 'FAILED', label: 'Eșuată' },
  { value: 'PENDING', label: 'Se generează' },
  { value: 'DONE', label: 'Emisă' },
  { value: 'NONE', label: 'Fără FGO' },
];

interface InvoiceRow {
  id: string;
  invoiceNumber: string | null;
  issuedAt: string;
  buyerName: string;
  buyerEmail: string;
  buyerType: string | null;
  buyerCui: string | null;
  buyerRegCom: string | null;
  buyerCountry: string | null;
  buyerCounty: string | null;
  buyerCity: string | null;
  buyerAddress: string | null;
  totalAmount: string | number;
  currency: string;
  fgoStatus: string | null;
  fgoSerie: string | null;
  fgoPdfUrl: string | null;
  fgoError: string | null;
  fgoWarning: string | null;
  invoiceEmailedAt: string | null;
  fgoStornoWanted: boolean;
  fgoStornoDoneAt: string | null;
}

function formatDate(value?: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('ro-RO');
}

function formatAmount(value: string | number, currency: string): string {
  const amount = Number(value);
  const formatted = Number.isFinite(amount)
    ? amount.toLocaleString('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '—';
  return `${formatted} ${currency}`;
}

// null means FGO was inactive when the invoice was created, so it was never queued
function fgoState(status?: string | null): [string, string] {
  if (status === 'DONE') return ['green', 'Emisă'];
  if (status === 'PENDING') return ['blue', 'Se generează'];
  if (status === 'FAILED') return ['red', 'Eșuată'];
  return ['default', 'Fără FGO'];
}

export const AdminInvoicesTab: React.FC = () => {
  const { user: authUser } = useAuth();
  const isSuperAdmin = authUser?.role === 'SUPER_ADMIN';

  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [failedCount, setFailedCount] = useState<number>(0);
  const [page, setPage] = useState<number>(1);
  const [status, setStatus] = useState<string>('ALL');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isActionRunning, setIsActionRunning] = useState<boolean>(false);

  const loadInvoices = async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/admin/invoices?page=${page}&status=${status}`);
      const data = await res.json();
      if (!res.ok) {
        message.error(data.message || 'Eroare la încărcarea facturilor.');
        return;
      }
      setRows(data.items || []);
      setTotal(data.total || 0);
      setFailedCount(data.failedCount || 0);
    } catch {
      message.error('Eroare de conexiune la încărcarea facturilor.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadInvoices();
  }, [page, status]);

  const runAction = async (url: string, successMessage: string): Promise<boolean> => {
    setIsActionRunning(true);
    try {
      const res = await fetch(url, { method: 'POST' });
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

  const handleRetry = async (invoice: InvoiceRow) => {
    const ok = await runAction(`/api/admin/invoices/${invoice.id}/retry`, 'Factura a fost reprogramată pentru emitere.');
    if (ok) await loadInvoices();
  };

  const handleResendEmail = async (invoice: InvoiceRow) => {
    const ok = await runAction(`/api/admin/invoices/${invoice.id}/resend-email`, 'Emailul cu factura a fost retrimis.');
    if (ok) await loadInvoices();
  };

  const handleStorno = async (invoice: InvoiceRow) => {
    const ok = await runAction(`/api/admin/invoices/${invoice.id}/storno`, 'Stornarea a fost programată.');
    if (ok) await loadInvoices();
  };

  const columns = [
    {
      title: 'Număr',
      dataIndex: 'invoiceNumber',
      key: 'invoiceNumber',
      width: 130,
      render: (value: string | null) => (
        <span className="text-xs font-mono text-ink">{value || '—'}</span>
      ),
    },
    {
      title: 'Data',
      dataIndex: 'issuedAt',
      key: 'issuedAt',
      width: 170,
      render: (value: string) => <span className="text-xs text-muted">{formatDate(value)}</span>,
    },
    {
      title: 'Client',
      dataIndex: 'buyerName',
      key: 'buyerName',
      render: (value: string) => <span className="text-xs text-ink">{value}</span>,
    },
    {
      title: 'Email',
      dataIndex: 'buyerEmail',
      key: 'buyerEmail',
      render: (value: string) => <span className="text-xs text-muted">{value}</span>,
    },
    {
      title: 'Total',
      key: 'totalAmount',
      width: 130,
      render: (_: any, record: InvoiceRow) => (
        <span className="text-xs font-semibold text-ink">
          {formatAmount(record.totalAmount, record.currency)}
        </span>
      ),
    },
    {
      title: 'Stare',
      key: 'fgoState',
      width: 140,
      render: (_: any, record: InvoiceRow) => {
        const [color, label] = fgoState(record.fgoStatus);
        return <Tag color={color}>{label}</Tag>;
      },
    },
    {
      title: 'Email trimis',
      key: 'invoiceEmailedAt',
      width: 120,
      render: (_: any, record: InvoiceRow) => (
        <Tag color={record.invoiceEmailedAt ? 'green' : 'default'}>
          {record.invoiceEmailedAt ? 'Trimis' : 'Netrimis'}
        </Tag>
      ),
    },
    {
      title: 'Storno',
      key: 'storno',
      width: 110,
      render: (_: any, record: InvoiceRow) => {
        if (record.fgoStornoDoneAt) return <Tag color="purple">Da</Tag>;
        if (record.fgoStornoWanted) return <Tag color="orange">În curs</Tag>;
        return <span className="text-xs text-muted">—</span>;
      },
    },
    {
      title: 'Acțiuni',
      key: 'actions',
      width: 240,
      render: (_: any, record: InvoiceRow) => (
        <div className="flex flex-wrap items-center gap-1">
          {record.fgoPdfUrl && (
            <Button
              type="text"
              size="small"
              href={record.fgoPdfUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              PDF
            </Button>
          )}

          {(record.fgoStatus === 'FAILED' || record.fgoStatus === 'PENDING') && (
            <Button
              type="text"
              size="small"
              disabled={isActionRunning}
              onClick={() => handleRetry(record)}
            >
              Reîncearcă
            </Button>
          )}

          {record.fgoPdfUrl && (
            <Button
              type="text"
              size="small"
              disabled={isActionRunning}
              onClick={() => handleResendEmail(record)}
            >
              Retrimite email
            </Button>
          )}

          {record.fgoSerie && !record.fgoStornoWanted && isSuperAdmin && (
            <Popconfirm
              title="Se emite factură storno în FGO. Acțiunea nu se anulează automat."
              okText="Stornează"
              cancelText="Anulează"
              okButtonProps={{ danger: true }}
              onConfirm={() => handleStorno(record)}
            >
              <Button type="text" size="small" danger disabled={isActionRunning}>
                Stornează
              </Button>
            </Popconfirm>
          )}
        </div>
      ),
    },
  ];

  const infoRow = (label: string, value: React.ReactNode) => (
    <div className="flex items-start justify-between gap-4">
      <span className="text-muted shrink-0">{label}</span>
      <span className="text-ink font-medium text-right break-all">{value}</span>
    </div>
  );

  return (
    <div className="pt-2 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <Select
          value={status}
          onChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
          options={STATUS_FILTERS}
          className="w-full sm:w-56"
        />
        <span className="text-xs text-muted">{total} facturi</span>
      </div>

      {failedCount > 0 && (
        <Alert
          type="warning"
          showIcon
          message={`${failedCount} facturi nu au putut fi emise în FGO și așteaptă o reîncercare.`}
        />
      )}

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
          showTotal: (count: number) => `${count} facturi`,
        }}
        onChange={(pagination) => setPage(pagination.current || 1)}
        expandable={{
          expandedRowRender: (record: InvoiceRow) => (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs py-1">
              {infoRow(
                'Eroare FGO',
                record.fgoError ? <span className="text-red-700">{record.fgoError}</span> : '—'
              )}
              {infoRow(
                'Avertisment FGO',
                record.fgoWarning ? <span className="text-orange-700">{record.fgoWarning}</span> : '—'
              )}
              {infoRow('Tip client', record.buyerType || '—')}
              {infoRow('CUI', record.buyerCui || '—')}
              {infoRow('Nr. Reg.', record.buyerRegCom || '—')}
              {infoRow('Adresă', record.buyerAddress || '—')}
              {infoRow('Județ', record.buyerCounty || '—')}
              {infoRow('Localitate', record.buyerCity || '—')}
              {infoRow('Țară', record.buyerCountry || '—')}
            </div>
          ),
        }}
        className="border border-ink/10 rounded-xl overflow-hidden"
      />
    </div>
  );
};
