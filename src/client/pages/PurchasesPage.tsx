import React, { useState, useEffect } from 'react';
import { Table, Tag, Button, Modal, Input, Empty, Skeleton, message } from 'antd';
import { FileTextOutlined, PrinterOutlined, CheckCircleOutlined, DownloadOutlined, DeleteOutlined } from '@ant-design/icons';
import { Purchase } from '../../types/index.ts';
import { useAuth } from '../context/AuthContext.tsx';
import { ChangePasswordForm } from '../components/ChangePasswordForm.tsx';

interface PurchasesPageProps {
  // Changes whenever a payment is confirmed: forces the purchase history to reload
  purchasesVersion: number;
}

export const PurchasesPage: React.FC<PurchasesPageProps> = ({ purchasesVersion }) => {
  const { user, logout } = useAuth();
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [selectedReceipt, setSelectedReceipt] = useState<any | null>(null);
  const [isDeleteOpen, setIsDeleteOpen] = useState<boolean>(false);
  const [deletePassword, setDeletePassword] = useState<string>('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);

  useEffect(() => {
    if (!user) return;
    setIsLoading(true);

    fetch('/api/account/purchases')
      .then((res) => res.json())
      .then((data) => setPurchases(data.purchases || []))
      .catch((e) => console.error(e))
      .finally(() => setIsLoading(false));
  }, [user, purchasesVersion]);

  const confirmDeleteAccount = async () => {
    setDeleteError(null);

    if (!deletePassword) {
      setDeleteError('Introdu parola contului pentru confirmare.');
      return;
    }

    setIsDeleting(true);
    try {
      const res = await fetch('/api/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: deletePassword }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setDeleteError(data.message || 'Ștergerea contului a eșuat.');
        return;
      }

      setIsDeleteOpen(false);
      await logout();
      window.location.href = '/';
    } catch (e) {
      console.error(e);
      setDeleteError('Ștergerea contului a eșuat. Încearcă din nou.');
    } finally {
      setIsDeleting(false);
    }
  };

  if (!user) {
    return (
      <div className="max-w-xl mx-auto px-6 py-28 text-center space-y-4">
        <h2 className="text-2xl font-semibold text-ink tracking-tight">Istoric Comenzi & Facturi</h2>
        <p className="text-sm text-muted">
          Autentifică-te pentru a vizualiza istoricul comenzilor, chitanțele și facturile Stripe emise.
        </p>
      </div>
    );
  }

  const columns = [
    {
      title: 'Factură Fiscală',
      dataIndex: 'invoiceNumber',
      key: 'invoice',
      render: (inv: string) => (
        <span className="font-mono text-xs text-ink font-medium tracking-wider">{inv || '—'}</span>
      ),
    },
    {
      title: 'Producție VOD',
      dataIndex: ['video', 'title'],
      key: 'videoTitle',
      render: (title: string, r: any) => (
        <span className="text-ink text-xs font-medium">{title || r.videoId}</span>
      ),
    },
    {
      title: 'Sumă (TVA incl.)',
      key: 'amount',
      render: (_: any, r: any) => (
        <span className="text-ink text-xs font-semibold">
          {r.amount} {r.currency}
        </span>
      ),
    },
    {
      title: 'Data Emiterii',
      dataIndex: 'createdAt',
      key: 'date',
      render: (d: string) => (
        <span className="text-xs text-muted">
          {new Date(d).toLocaleDateString('ro-RO', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          })}
        </span>
      ),
    },
    {
      title: 'Status Plată',
      dataIndex: 'status',
      key: 'status',
      render: (st: string) => (
        <Tag color={st === 'PAID' ? 'success' : st === 'REFUNDED' ? 'warning' : 'default'} className="text-[11px] font-medium">
          {st === 'PAID' ? 'ACHITAT' : st}
        </Tag>
      ),
    },
    {
      title: 'Acțiuni',
      key: 'actions',
      render: (_: any, r: any) => {
        const invoice = r.invoice;
        if (!invoice) return null;

        // A factura emisă de FGO are PDF-ul propriu: chitanța internă nu mai este necesară
        if (invoice.fgoPdfUrl || invoice.fgoStornoPdfUrl || invoice.fgoStatus) {
          return (
            <div className="flex flex-col items-start gap-1">
              {invoice.fgoPdfUrl && (
                <Button
                  type="text"
                  size="small"
                  icon={<DownloadOutlined />}
                  href={invoice.fgoPdfUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-ink/80 hover:text-ink px-0"
                >
                  Descarcă factura (PDF)
                </Button>
              )}
              {invoice.fgoStornoPdfUrl && (
                <Button
                  type="text"
                  size="small"
                  icon={<DownloadOutlined />}
                  href={invoice.fgoStornoPdfUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-ink/80 hover:text-ink px-0"
                >
                  Descarcă factura storno
                </Button>
              )}
              {invoice.fgoStatus && !invoice.fgoPdfUrl && (
                <span className="text-[11px] text-muted">
                  Factura se generează. O vei primi pe email.
                </span>
              )}
            </div>
          );
        }

        return (
          <div className="flex items-center gap-2">
            <Button
              type="text"
              size="small"
              icon={<FileTextOutlined />}
              onClick={() => setSelectedReceipt(r)}
              className="text-xs text-ink/80 hover:text-ink"
            >
              Vezi Factură
            </Button>
            <Button
              type="text"
              size="small"
              icon={<PrinterOutlined />}
              onClick={() => window.open(`/api/account/invoices/${invoice.id}/print`, '_blank')}
              className="text-xs text-muted hover:text-ink-soft"
            >
              Tipărește
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-8 animate-in fade-in duration-300">
      <div className="border-b border-ink/10 pb-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink tracking-tight">
            Istoric Comenzi & Facturi
          </h1>
          <p className="text-xs text-muted mt-1">
            Facturi fiscale digitale emise automat și confirmări de plată Stripe pentru {user.email}.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted bg-ink/[0.03] border border-ink/10 px-3 py-1.5 rounded-lg">
          <CheckCircleOutlined className="text-emerald-700" />
          <span>Confirmare automată prin SMTP</span>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton active paragraph={{ rows: 5 }} />
        </div>
      ) : purchases.length === 0 ? (
        <div className="py-20 text-center max-w-md mx-auto">
          <Empty
            description={
              <span className="text-muted text-sm">
                Nu există comenzi înregistrate în contul tău.
              </span>
            }
          />
        </div>
      ) : (
        <Table
          dataSource={purchases}
          columns={columns}
          rowKey="id"
          pagination={false}
          className="border border-ink/10 rounded-xl overflow-hidden"
        />
      )}

      {/* GDPR: "Datele mele" */}
      <div className="border border-ink/10 rounded-xl p-5 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-ink tracking-tight">Datele mele</h2>
          <p className="text-xs text-muted mt-1">
            Descarcă o copie a datelor din cont sau solicită ștergerea definitivă a contului.
          </p>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <Button
            href="/api/account/export"
            icon={<DownloadOutlined />}
            className="h-10 text-xs rounded-xl"
          >
            Descarcă datele mele
          </Button>
          <Button
            danger
            icon={<DeleteOutlined />}
            onClick={() => {
              setDeletePassword('');
              setDeleteError(null);
              setIsDeleteOpen(true);
            }}
            className="h-10 text-xs rounded-xl"
          >
            Șterge contul
          </Button>
        </div>

        <div className="pt-3 border-t border-ink/10 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-ink">Schimbă parola</h3>
            <p className="text-xs text-muted mt-1">
              Folosește parola actuală pentru a seta una nouă.
            </p>
          </div>
          <ChangePasswordForm />
        </div>
      </div>

      {/* Stripe Digital Invoice Modal */}
      {selectedReceipt && (
        <Modal
          open={true}
          onCancel={() => setSelectedReceipt(null)}
          footer={null}
          centered
          width={520}
        >
          <div className="py-2 space-y-6">
            {/* Header */}
            <div className="flex items-start justify-between border-b border-ink/10 pb-4">
              <div>
                <span className="inline-block px-2.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-700 text-[11px] font-semibold uppercase tracking-wider mb-1.5">
                  Achitat • card
                </span>
                <h3 className="text-lg font-semibold text-ink tracking-tight">
                  Factură Fiscală Digitală
                </h3>
                <p className="text-xs text-muted font-mono">
                  #{selectedReceipt.invoice.invoiceNumber}
                </p>
              </div>
              <div className="text-right text-xs text-muted">
                <span className="block text-ink font-medium">{selectedReceipt.invoice.sellerName}</span>
                <span className="block text-[11px]">CIF: {selectedReceipt.invoice.sellerCif}</span>
                <span className="block text-[11px]">{selectedReceipt.invoice.sellerAddress}</span>
              </div>
            </div>

            {/* Buyer Details */}
            <div className="grid grid-cols-2 gap-4 text-xs bg-ink/[0.03] border border-ink/10 p-3 rounded-lg">
              <div>
                <span className="text-muted/80 block text-[11px]">Cumpărător:</span>
                <span className="text-ink font-medium">{user.username}</span>
                <span className="text-muted block">{user.email}</span>
              </div>
              <div className="text-right">
                <span className="text-muted/80 block text-[11px]">Procesator de plată:</span>
                <span className="text-ink font-medium">Stripe Checkout</span>
                <span className="text-muted block">Licență digitală permanentă</span>
              </div>
            </div>

            {/* Items */}
            <div className="space-y-3 py-2 text-xs">
              <div className="flex justify-between items-center text-muted pb-2 border-b border-ink/10 text-[11px]">
                <span>PRODUS</span>
                <span>TOTAL</span>
              </div>
              <div className="flex justify-between items-start">
                <div>
                  <span className="text-ink font-medium block">
                    {selectedReceipt.video?.title}
                  </span>
                  <span className="text-[11px] text-muted">
                    Licență VOD permanentă
                  </span>
                </div>
                <span className="text-ink font-semibold">
                  {selectedReceipt.invoice.totalAmount} {selectedReceipt.invoice.currency}
                </span>
              </div>
            </div>

            {/* Breakdown */}
            <div className="border-t border-ink/10 pt-3 space-y-1.5 text-xs">
              <div className="flex justify-between text-muted">
                <span>Subtotal (fără TVA):</span>
                <span className="text-ink">
                  {selectedReceipt.invoice.subtotal.toFixed(2)} {selectedReceipt.invoice.currency}
                </span>
              </div>
              <div className="flex justify-between text-muted">
                <span>TVA ({Math.round(selectedReceipt.invoice.taxRate * 10000) / 100}% inclusă):</span>
                <span className="text-ink">
                  {selectedReceipt.invoice.taxAmount.toFixed(2)} {selectedReceipt.invoice.currency}
                </span>
              </div>
              <div className="flex justify-between text-ink font-semibold text-sm pt-2 border-t border-ink/10">
                <span>Total achitat:</span>
                <span className="text-emerald-700">
                  {selectedReceipt.invoice.totalAmount} {selectedReceipt.invoice.currency}
                </span>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex items-center gap-3 pt-2">
              <Button
                type="primary"
                icon={<PrinterOutlined />}
                onClick={() => window.open(`/api/account/invoices/${selectedReceipt.invoice.id}/print`, '_blank')}
                className="flex-1 bg-ink text-cream hover:!bg-ink-soft hover:!text-cream border-none font-medium text-xs h-10 rounded-xl"
              >
                Printează / Descarcă PDF
              </Button>
              <Button
                onClick={() => setSelectedReceipt(null)}
                className="h-10 text-xs rounded-xl"
              >
                Închide
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Account erasure confirmation */}
      <Modal
        open={isDeleteOpen}
        onCancel={() => setIsDeleteOpen(false)}
        title="Șterge contul"
        okText="Șterge definitiv contul"
        cancelText="Anulează"
        okButtonProps={{ danger: true, loading: isDeleting }}
        onOk={confirmDeleteAccount}
        centered
        width={460}
      >
        <div className="py-2 space-y-4">
          <p className="text-sm text-ink">
            Pierzi definitiv accesul la filmele cumpărate. Facturile se păstrează conform legii.
          </p>
          <div>
            <label className="block text-xs text-muted mb-1">Confirmă parola contului:</label>
            <Input.Password
              value={deletePassword}
              onChange={(e) => setDeletePassword(e.target.value)}
              placeholder="Parola contului"
              autoComplete="current-password"
            />
          </div>
          {deleteError && <p className="text-xs text-red-600">{deleteError}</p>}
        </div>
      </Modal>
    </div>
  );
};
