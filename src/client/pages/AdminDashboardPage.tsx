import React, { useState, useEffect } from 'react';
import {
  Tabs,
  Table,
  Button,
  Drawer,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  Tag,
  Modal,
  Popconfirm,
  notification,
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ReloadOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  VideoCameraOutlined,
  UserOutlined,
  DollarOutlined,
  SafetyCertificateOutlined,
  MailOutlined,
  SendOutlined,
  EyeOutlined,
  PrinterOutlined,
} from '@ant-design/icons';
import { Video, AuditLog, Category, EmailLog } from '../../types/index.ts';
import { AdminUsersTab } from './AdminUsersTab.tsx';
import { AdminCategoriesTab } from './AdminCategoriesTab.tsx';

// Sends a file as the raw request body, reporting upload progress (fetch has no upload progress)
function uploadFile(url: string, file: File, onProgress: (percent: number) => void): Promise<any> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let data: any = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status < 300) resolve(data);
      else reject(new Error(data.message || `Încărcarea a eșuat (HTTP ${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error('Conexiunea s-a întrerupt în timpul încărcării.'));
    xhr.send(file);
  });
}

// Reads the duration from the file itself, in the browser, before upload
function readVideoDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const el = document.createElement('video');
    el.preload = 'metadata';
    el.onloadedmetadata = () => {
      URL.revokeObjectURL(el.src);
      resolve(Math.round(el.duration) || 0);
    };
    el.onerror = () => resolve(0);
    el.src = URL.createObjectURL(file);
  });
}

interface AdminDashboardPageProps {
  initialSubTab?: string;
  onExitAdmin?: () => void;
}

export const AdminDashboardPage: React.FC<AdminDashboardPageProps> = ({
  initialSubTab = 'overview',
  onExitAdmin,
}) => {
  const [activeTab, setActiveTab] = useState<string>(initialSubTab);

  // Data states
  const [kpis, setKpis] = useState<any>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [purchases, setPurchases] = useState<any[]>([]);
  const [liveLogs, setLiveLogs] = useState<AuditLog[]>([]);
  const [paymentConfig, setPaymentConfig] = useState<any>(null);
  const [smtpData, setSmtpData] = useState<any>(null);
  const [sentEmails, setSentEmails] = useState<EmailLog[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  // Email test & preview states
  const [isTestEmailModalOpen, setIsTestEmailModalOpen] = useState<boolean>(false);
  const [testRecipient, setTestRecipient] = useState<string>('');
  const [isSendingTest, setIsSendingTest] = useState<boolean>(false);
  const [isVerifyingSmtp, setIsVerifyingSmtp] = useState<boolean>(false);
  const [previewEmail, setPreviewEmail] = useState<EmailLog | null>(null);

  // Video drawer states
  const [isDrawerOpen, setIsDrawerOpen] = useState<boolean>(false);
  const [editingVideo, setEditingVideo] = useState<Video | null>(null);
  const [videoForm] = Form.useForm();
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [thumbFile, setThumbFile] = useState<File | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [newCategoryName, setNewCategoryName] = useState<string>('');
  const [drawerKey, setDrawerKey] = useState<number>(0); // remounts file inputs so they never show a stale file

  // Load Admin Data
  const loadData = async () => {
    setIsLoading(true);
    try {
      const [kpiRes, vidRes, catRes, purRes, payRes, smtpRes, emailsRes] = await Promise.all([
        fetch('/api/admin/dashboard').then((r) => r.json()),
        fetch('/api/admin/videos').then((r) => r.json()),
        fetch('/api/categories').then((r) => r.json()),
        fetch('/api/admin/purchases').then((r) => r.json()),
        fetch('/api/payments/config').then((r) => r.json()).catch(() => null),
        fetch('/api/admin/smtp').then((r) => r.json()).catch(() => null),
        fetch('/api/admin/emails').then((r) => r.json()).catch(() => null),
      ]);

      setKpis(kpiRes.kpis);
      setVideos(vidRes.videos || []);
      setCategories(catRes.categories || []);
      setPurchases(purRes.purchases || []);
      if (payRes) setPaymentConfig(payRes);
      if (smtpRes) setSmtpData(smtpRes);
      if (emailsRes) setSentEmails(emailsRes.emails || []);
    } catch (e) {
      console.error(e);
      notification.error({ message: 'Eroare la încărcarea datelor administrative' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerifySmtp = async () => {
    setIsVerifyingSmtp(true);
    try {
      const res = await fetch('/api/admin/smtp/verify', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        notification.success({
          message: 'Verificare SMTP',
          description: data.message,
        });
      } else {
        notification.error({
          message: 'Eroare SMTP',
          description: data.message,
        });
      }
    } catch (err: any) {
      notification.error({ message: 'Eroare conexiune SMTP', description: err.message });
    } finally {
      setIsVerifyingSmtp(false);
    }
  };

  const handleSendTestEmail = async () => {
    if (!testRecipient || !testRecipient.includes('@')) {
      notification.warning({ message: 'Introduceți o adresă de email validă' });
      return;
    }

    setIsSendingTest(true);
    try {
      const res = await fetch('/api/admin/smtp/test-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: testRecipient }),
      });
      const data = await res.json();

      if (data.success) {
        notification.success({
          message: 'Email de test trimis',
          description: `Emailul a fost expediat către ${testRecipient} (Status: ${data.log?.status}).`,
        });
        setIsTestEmailModalOpen(false);
        setTestRecipient('');
        // Refresh emails
        const emailsRes = await fetch('/api/admin/emails').then((r) => r.json());
        if (emailsRes?.emails) setSentEmails(emailsRes.emails);
      } else {
        notification.error({ message: 'Trimitere eșuată', description: data.error });
      }
    } catch (err: any) {
      notification.error({ message: 'Eroare trimitere test', description: err.message });
    } finally {
      setIsSendingTest(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // SSE Live Activity Stream Listener
  useEffect(() => {
    const eventSource = new EventSource('/api/admin/live-activity');

    eventSource.onmessage = (e) => {
      try {
        const log = JSON.parse(e.data);
        if (log && log.eventType) {
          setLiveLogs((prev) => [log, ...prev.slice(0, 99)]);
        }
      } catch {}
    };

    return () => {
      eventSource.close();
    };
  }, []);

  // Fetch initial audit logs
  useEffect(() => {
    fetch('/api/admin/audit-logs')
      .then((r) => r.json())
      .then((d) => setLiveLogs(d.logs || []))
      .catch(() => {});
  }, []);

  // Open Drawer for Add / Edit
  const openVideoDrawer = (video?: Video) => {
    setVideoFile(null);
    setThumbFile(null);
    setUploadStatus(null);
    setDrawerKey((k) => k + 1);
    if (video) {
      setEditingVideo(video);
      videoForm.setFieldsValue({
        title: video.title,
        description: video.description,
        categoryId: video.categoryId,
        priceAmount: video.priceAmount,
        isPublished: video.isPublished,
      });
    } else {
      setEditingVideo(null);
      videoForm.resetFields();
      videoForm.setFieldsValue({
        categoryId: categories[0]?.id,
        isPublished: true,
      });
    }
    setIsDrawerOpen(true);
  };

  const handleCreateCategory = async () => {
    const name = newCategoryName.trim();
    if (!name) return;
    const res = await fetch('/api/admin/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) {
      notification.error({ message: 'Eroare categorie', description: data.message });
      return;
    }
    setCategories((prev) => [...prev, data.category]);
    videoForm.setFieldsValue({ categoryId: data.category.id });
    setNewCategoryName('');
  };

  // Submit Add / Edit Video: save details, upload files, then publish
  const handleVideoSubmit = async (values: any) => {
    const { isPublished, ...details } = values;

    if (!editingVideo && (!videoFile || !thumbFile)) {
      notification.warning({ message: 'Alege fișierul video și imaginea de copertă.' });
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch(editingVideo ? `/api/admin/videos/${editingVideo.id}` : '/api/admin/videos', {
        method: editingVideo ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(details),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Eroare la salvarea videoclipului');
      const videoId = data.video.id;

      if (thumbFile) {
        await uploadFile(
          `/api/admin/videos/${videoId}/thumbnail?name=${encodeURIComponent(thumbFile.name)}`,
          thumbFile,
          (p) => setUploadStatus(`Imagine: ${p}%`)
        );
      }

      if (videoFile) {
        const duration = await readVideoDuration(videoFile);
        await uploadFile(
          `/api/admin/videos/${videoId}/file?name=${encodeURIComponent(videoFile.name)}&duration=${duration}`,
          videoFile,
          (p) => setUploadStatus(`Video: ${p}%`)
        );
      }

      if (Boolean(isPublished) !== Boolean(editingVideo?.isPublished)) {
        const pub = await fetch(`/api/admin/videos/${videoId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isPublished: Boolean(isPublished) }),
        });
        if (!pub.ok) throw new Error((await pub.json()).message || 'Publicarea a eșuat');
      }

      notification.success({
        message: editingVideo ? 'Videoclip actualizat' : 'Videoclip încărcat',
        description: videoFile
          ? 'Bunny Stream procesează filmul (de obicei câteva minute). Apare în catalog când statusul devine „Gata” — apasă Actualizează.'
          : undefined,
      });
      setIsDrawerOpen(false);
      loadData();
    } catch (err: any) {
      notification.error({ message: 'Eroare', description: err.message });
      loadData();
    } finally {
      setIsSubmitting(false);
      setUploadStatus(null);
    }
  };

  // Toggle Publish
  const handleTogglePublish = async (video: Video) => {
    const res = await fetch(`/api/admin/videos/${video.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPublished: !video.isPublished }),
    });
    if (res.ok) {
      notification.success({ message: video.isPublished ? 'Videoclip ascuns' : 'Videoclip publicat' });
      loadData();
    } else {
      notification.error({ message: 'Eroare la modificarea stării', description: (await res.json()).message });
    }
  };

  // Delete Video
  const handleDeleteVideo = async (id: string) => {
    const res = await fetch(`/api/admin/videos/${id}`, { method: 'DELETE' });
    if (res.ok) {
      notification.success({ message: 'Videoclip șters definitiv' });
      loadData();
    } else {
      notification.error({ message: 'Nu se poate șterge', description: (await res.json()).message });
    }
  };

  // Video Table Columns
  const videoColumns = [
    {
      title: 'Previzualizare',
      dataIndex: 'thumbnailUrl',
      key: 'thumbnail',
      width: 140,
      render: (thumb: string, record: Video) => (
        <div className="relative aspect-video w-28 rounded-lg overflow-hidden bg-cream border border-ink/10">
          <img src={thumb} alt={record.title} className="w-full h-full object-cover" />
        </div>
      ),
    },
    {
      title: 'Titlu & Detalii',
      key: 'title',
      render: (_: any, record: Video) => (
        <div>
          <div className="font-medium text-ink text-sm">{record.title}</div>
          <div className="text-xs text-muted line-clamp-1">{record.description}</div>
          <div className="text-[11px] text-muted mt-0.5">{record.category?.name}</div>
        </div>
      ),
    },
    {
      title: 'Preț',
      dataIndex: 'priceAmount',
      key: 'price',
      width: 110,
      render: (price: number, record: Video) => (
        <span className="font-semibold text-ink">
          {price} {record.currency}
        </span>
      ),
    },
    {
      title: 'Status Procesare',
      dataIndex: 'status',
      key: 'status',
      width: 130,
      render: (status: string) => {
        const labels: Record<string, [string, string]> = {
          UPLOADING: ['default', 'Fără fișier'],
          PROCESSING: ['processing', 'Se procesează (Bunny)'],
          READY: ['success', 'Gata'],
          FAILED: ['error', 'Eroare — reîncarcă'],
        };
        const [color, label] = labels[status] || ['default', status];
        return <Tag color={color}>{label}</Tag>;
      },
    },
    {
      title: 'Publicat',
      dataIndex: 'isPublished',
      key: 'isPublished',
      width: 100,
      render: (published: boolean, record: Video) => (
        <Switch
          checked={published}
          onChange={() => handleTogglePublish(record)}
          size="small"
        />
      ),
    },
    {
      title: 'Acțiuni',
      key: 'actions',
      width: 110,
      render: (_: any, record: Video) => (
        <div className="flex items-center gap-2">
          <Button
            type="text"
            size="small"
            icon={<EditOutlined className="text-muted hover:text-ink" />}
            onClick={() => openVideoDrawer(record)}
          />
          <Popconfirm
            title="Ștergeți videoclipul?"
            description="Această acțiune este ireversibilă."
            okText="Șterge"
            cancelText="Anulează"
            okButtonProps={{ danger: true }}
            onConfirm={() => handleDeleteVideo(record.id)}
          >
            <Button
              type="text"
              size="small"
              danger
              icon={<DeleteOutlined />}
            />
          </Popconfirm>
        </div>
      ),
    },
  ];

  // Purchases Table Columns
  const purchaseColumns = [
    {
      title: 'ID Tranzacție',
      dataIndex: 'id',
      key: 'id',
      render: (id: string) => <span className="font-mono text-xs text-muted">{id.slice(0, 14)}...</span>,
    },
    {
      title: 'Client',
      dataIndex: ['user', 'email'],
      key: 'userEmail',
      render: (email: string) => <span className="text-ink text-xs">{email}</span>,
    },
    {
      title: 'Videoclip',
      dataIndex: ['video', 'title'],
      key: 'videoTitle',
      render: (title: string) => <span className="text-ink/80 text-xs">{title}</span>,
    },
    {
      title: 'Sumă',
      key: 'amount',
      render: (_: any, record: any) => (
        <span className="font-semibold text-ink text-xs">
          {record.amount} {record.currency}
        </span>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => {
        const color = status === 'PAID' ? 'success' : status === 'REFUNDED' ? 'warning' : 'error';
        return <Tag color={color}>{status}</Tag>;
      },
    },
    {
      title: 'Dată',
      dataIndex: 'createdAt',
      key: 'date',
      render: (date: string) => (
        <span className="text-xs text-muted">
          {new Date(date).toLocaleDateString('ro-RO', { hour: '2-digit', minute: '2-digit' })}
        </span>
      ),
    },
  ];

  // Live Logs Columns
  const logColumns = [
    {
      title: 'Timestamp',
      dataIndex: 'createdAt',
      key: 'timestamp',
      width: 140,
      render: (t: string) => (
        <span className="font-mono text-[11px] text-muted">
          {new Date(t).toLocaleTimeString('ro-RO')}
        </span>
      ),
    },
    {
      title: 'Eveniment',
      dataIndex: 'eventType',
      key: 'eventType',
      render: (type: string) => <span className="font-mono text-xs text-ink">{type}</span>,
    },
    {
      title: 'Utilizator / IP',
      key: 'origin',
      render: (_: any, r: AuditLog) => (
        <div className="text-xs">
          <div className="text-ink">{r.userEmail || 'Sistem'}</div>
          <div className="text-[10px] text-muted font-mono">{r.ip}</div>
        </div>
      ),
    },
    {
      title: 'Severitate',
      dataIndex: 'severity',
      key: 'severity',
      width: 100,
      render: (sev: string) => {
        const color = sev === 'CRITICAL' ? 'error' : sev === 'WARNING' ? 'warning' : 'default';
        return <Tag color={color}>{sev}</Tag>;
      },
    },
  ];

  const emailColumns = [
    {
      title: 'Destinatar',
      dataIndex: 'to',
      key: 'to',
      render: (to: string) => <span className="text-ink text-xs font-medium">{to}</span>,
    },
    {
      title: 'Subiect',
      dataIndex: 'subject',
      key: 'subject',
      render: (sub: string) => (
        <span className="text-ink/80 text-xs truncate max-w-xs block font-medium">{sub}</span>
      ),
    },
    {
      title: 'Tip Email',
      dataIndex: 'type',
      key: 'type',
      render: (type: string) => {
        const typeMap: Record<string, { label: string; color: string }> = {
          WELCOME: { label: 'Bun venit', color: 'blue' },
          PURCHASE_CONFIRMATION: { label: 'Achiziție', color: 'green' },
          STRIPE_INVOICE: { label: 'Factură Stripe', color: 'purple' },
          TEST: { label: 'Test SMTP', color: 'orange' },
        };
        const cur = typeMap[type] || { label: type, color: 'default' };
        return <Tag color={cur.color} className="text-[11px] font-medium">{cur.label}</Tag>;
      },
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (st: string) => (
        <Tag color={st === 'SENT' ? 'success' : 'error'} className="text-[11px] font-medium">
          {st === 'SENT' ? 'EXPEDIAT' : 'EȘUAT'}
        </Tag>
      ),
    },
    {
      title: 'Dată',
      dataIndex: 'sentAt',
      key: 'sentAt',
      render: (d: string) => (
        <span className="text-xs text-muted">
          {new Date(d).toLocaleDateString('ro-RO', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
      ),
    },
    {
      title: 'Previzualizare',
      key: 'actions',
      render: (_: any, r: EmailLog) => (
        <Button
          type="text"
          size="small"
          icon={<EyeOutlined />}
          onClick={() => setPreviewEmail(r)}
          className="text-xs text-muted hover:text-ink"
        >
          Deschide
        </Button>
      ),
    },
  ];

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-8 animate-in fade-in duration-300">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-ink/10 pb-6">
        <div>
          <h1 className="text-2xl font-semibold text-ink tracking-tight">
            Studio Administration
          </h1>
          <p className="text-xs text-muted mt-1">
            Platformă de administrare a catalogului, streaming securizat nativ și gateway plăți Stripe.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button
            icon={<ReloadOutlined />}
            onClick={loadData}
            loading={isLoading}
            className="rounded-xl text-xs font-medium"
          >
            Actualizează
          </Button>

          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => openVideoDrawer()}
            className="rounded-xl text-xs font-semibold bg-ink text-cream hover:!bg-ink-soft hover:!text-cream border-none"
          >
            Adaugă Videoclip
          </Button>
        </div>
      </div>

      {/* Main Tabs */}
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: 'overview',
            label: 'Overview',
            children: (
              <div className="space-y-8 pt-2">
                {/* 4 Clean Essential KPI Cards */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="p-5 rounded-2xl bg-cream border border-ink/10 space-y-2">
                    <span className="text-xs text-muted font-medium">Venit Total</span>
                    <div className="text-2xl font-semibold text-ink tracking-tight">
                      {(kpis?.totalRevenueRon ?? 0).toLocaleString('ro-RO')} RON
                    </div>
                    <div className="text-[11px] text-muted">
                      Astăzi: {kpis?.revenueTodayRon ?? 0} RON
                    </div>
                  </div>

                  <div className="p-5 rounded-2xl bg-cream border border-ink/10 space-y-2">
                    <span className="text-xs text-muted font-medium">Vânzări Totale</span>
                    <div className="text-2xl font-semibold text-ink tracking-tight">
                      {kpis?.totalSalesCount ?? 0}
                    </div>
                  </div>

                  <div className="p-5 rounded-2xl bg-cream border border-ink/10 space-y-2">
                    <span className="text-xs text-muted font-medium">Utilizatori Înregistrați</span>
                    <div className="text-2xl font-semibold text-ink tracking-tight">
                      {kpis?.totalUsers ?? 0}
                    </div>
                    <div className="text-[11px] text-muted">
                      Activitate 24h: {kpis?.activeUsers24h ?? 0}
                    </div>
                  </div>

                  <div className="p-5 rounded-2xl bg-cream border border-ink/10 space-y-2">
                    <span className="text-xs text-muted font-medium">Stream-uri Active</span>
                    <div className="text-2xl font-semibold text-ink tracking-tight">
                      {kpis?.activeStreamsCount ?? 0}
                    </div>
                    <div className="text-[11px] text-emerald-700 flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      Token Heartbeat activ
                    </div>
                  </div>
                </div>

                {/* System & Stripe Status Card */}
                <div className="p-4 rounded-xl bg-cream/80 border border-ink/10 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-2.5">
                    <span className="font-semibold text-ink">Gateway Plăți:</span>
                    <Tag color={paymentConfig?.mode === 'live' ? 'green' : 'orange'}>
                      Stripe {paymentConfig?.mode === 'live' ? 'LIVE' : 'TEST (sk_test_ — plățile nu sunt reale)'}
                    </Tag>
                  </div>
                </div>

                {/* Recent Purchases Table */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-ink">Ultimele Tranzacții</h3>
                    <span className="text-xs text-muted">{purchases.length} înregistrări</span>
                  </div>
                  <Table
                    dataSource={purchases.slice(0, 5)}
                    columns={purchaseColumns}
                    rowKey="id"
                    pagination={false}
                    className="border border-ink/10 rounded-xl overflow-hidden"
                  />
                </div>

                {/* Top Selling Videos */}
                {kpis?.topVideos && kpis.topVideos.length > 0 && (
                  <div className="space-y-4">
                    <h3 className="text-sm font-semibold text-ink">Top Producții</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      {kpis.topVideos.slice(0, 3).map((item: any, idx: number) => (
                        <div
                          key={idx}
                          className="flex items-center gap-3 p-3.5 rounded-xl bg-cream/80 border border-ink/10"
                        >
                          <img
                            src={item.video.thumbnailUrl}
                            alt={item.video.title}
                            className="w-14 aspect-video rounded-lg object-cover"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-medium text-ink truncate">
                              {item.video.title}
                            </div>
                            <div className="text-[11px] text-muted">
                              {item.salesCount} vânzări • {item.revenue} RON
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ),
          },
          {
            key: 'videos',
            label: `Catalog Videoclipuri (${videos.length})`,
            children: (
              <div className="pt-2">
                <Table
                  dataSource={videos}
                  columns={videoColumns}
                  rowKey="id"
                  pagination={{ pageSize: 8 }}
                  className="border border-ink/10 rounded-xl overflow-hidden"
                />
              </div>
            ),
          },
          {
            key: 'orders',
            label: `Tranzacții & Licențe (${purchases.length})`,
            children: (
              <div className="pt-2">
                <Table
                  dataSource={purchases}
                  columns={purchaseColumns}
                  rowKey="id"
                  pagination={{ pageSize: 10 }}
                  className="border border-ink/10 rounded-xl overflow-hidden"
                />
              </div>
            ),
          },
          {
            key: 'security',
            label: 'Audit & Live Feed',
            children: (
              <div className="pt-2 space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted">
                    Flux live generat în timp real prin Server-Sent Events (SSE).
                  </span>
                  <Tag color="cyan">Conexiune activă</Tag>
                </div>
                <Table
                  dataSource={liveLogs}
                  columns={logColumns}
                  rowKey={(r) => `${r.id}-${r.createdAt}`}
                  pagination={{ pageSize: 10 }}
                  className="border border-ink/10 rounded-xl overflow-hidden"
                />
              </div>
            ),
          },
          {
            key: 'smtp',
            label: `Email & Facturi SMTP (${sentEmails.length})`,
            children: (
              <div className="pt-2 space-y-6">
                {/* SMTP Status Overview Card */}
                <div className="p-5 rounded-2xl bg-cream border border-ink/15 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-ink tracking-tight">
                          Server Expediție SMTP & Notificări
                        </h3>
                      </div>
                      <p className="text-xs text-muted mt-1">
                        Trimite automat email-uri de bun venit, confirmări de achiziție și facturi fiscale.
                      </p>
                    </div>

                    <div className="flex items-center gap-2.5">
                      <Button
                        size="small"
                        loading={isVerifyingSmtp}
                        onClick={handleVerifySmtp}
                        className="text-xs h-8 rounded-lg"
                      >
                        Verifică Conexiune
                      </Button>
                      <Button
                        type="primary"
                        size="small"
                        icon={<SendOutlined />}
                        onClick={() => setIsTestEmailModalOpen(true)}
                        className="bg-ink text-cream hover:!bg-ink-soft hover:!text-cream border-none text-xs h-8 rounded-lg font-medium"
                      >
                        Trimite Email de Test
                      </Button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-3 border-t border-ink/10 text-xs">
                    <div>
                      <span className="text-muted/80 block text-[11px]">Server Host:</span>
                      <span className="text-ink font-mono font-medium truncate block">
                        {smtpData?.config?.host}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted/80 block text-[11px]">Port / Securitate:</span>
                      <span className="text-ink font-mono font-medium">
                        {smtpData?.config?.port} {smtpData?.config?.secure ? '(SSL/TLS)' : '(STARTTLS)'}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted/80 block text-[11px]">Adresă Expeditor:</span>
                      <span className="text-ink font-mono font-medium truncate block">
                        {smtpData?.config?.from}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted/80 block text-[11px]">Expediate / Eșuate:</span>
                      <span className="text-emerald-700 font-semibold font-mono">
                        {smtpData?.stats?.totalSent ?? 0}
                      </span>
                      <span className="text-muted/80 font-mono"> / </span>
                      <span className="text-red-700 font-semibold font-mono">
                        {smtpData?.stats?.failed ?? 0}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Workflow Cards */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="p-4 rounded-xl bg-cream/70 border border-ink/10 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-blue-400" />
                      <span className="text-xs font-semibold text-ink">1. Înregistrare & Bun venit</span>
                    </div>
                    <p className="text-[11px] text-muted leading-relaxed">
                      Trimis automat utilizatorului imediat după înregistrare. Conține datele contului și link direct de explorare.
                    </p>
                  </div>
                  <div className="p-4 rounded-xl bg-cream/70 border border-ink/10 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-emerald-400" />
                      <span className="text-xs font-semibold text-ink">2. Confirmare Achiziție</span>
                    </div>
                    <p className="text-[11px] text-muted leading-relaxed">
                      Trimis la confirmarea plății Stripe. Activează licența permanentă și include buton de vizionare instantanee.
                    </p>
                  </div>
                  <div className="p-4 rounded-xl bg-cream/70 border border-ink/10 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-purple-400" />
                      <span className="text-xs font-semibold text-ink">3. Factură Fiscală Stripe</span>
                    </div>
                    <p className="text-[11px] text-muted leading-relaxed">
                      Factură fiscală cu număr secvențial, TVA inclus și datele firmei din configurare (COMPANY_* în .env).
                    </p>
                  </div>
                </div>

                {/* Sent Emails Table */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-ink">Istoric Email-uri Expediate</h3>
                    <span className="text-xs text-muted">{sentEmails.length} mesaje</span>
                  </div>
                  <Table
                    dataSource={sentEmails}
                    columns={emailColumns}
                    rowKey="id"
                    pagination={{ pageSize: 8 }}
                    className="border border-ink/10 rounded-xl overflow-hidden"
                  />
                </div>
              </div>
            ),
          },
          {
            key: 'users',
            label: 'Utilizatori',
            children: <AdminUsersTab />,
          },
          {
            key: 'categories',
            label: `Categorii (${categories.length})`,
            children: (
              <AdminCategoriesTab
                onCategoriesChanged={() => {
                  fetch('/api/categories')
                    .then((r) => r.json())
                    .then((d) => setCategories(d.categories || []))
                    .catch(() => {});
                }}
              />
            ),
          },
        ]}
      />

      {/* Add / Edit Video Drawer */}
      <Drawer
        title={editingVideo ? 'Modificare Videoclip' : 'Adăugare Videoclip Nou'}
        open={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        width={480}
        destroyOnHidden
      >
        <Form
          form={videoForm}
          layout="vertical"
          onFinish={handleVideoSubmit}
          requiredMark={false}
          className="space-y-4"
        >
          <Form.Item
            name="title"
            label={<span className="text-xs text-ink/80">Titlu Producție</span>}
            rules={[{ required: true, message: 'Introduceți titlul videoclipului' }]}
          >
            <Input placeholder="ex: Arta Compoziției Cinematice" />
          </Form.Item>

          <Form.Item
            name="description"
            label={<span className="text-xs text-ink/80">Descriere Scurtă</span>}
            rules={[{ required: true, message: 'Introduceți descrierea' }]}
          >
            <Input.TextArea rows={3} placeholder="Descriere concisă de 1-2 propoziții..." />
          </Form.Item>

          <div className="grid grid-cols-2 gap-4">
            <Form.Item
              name="categoryId"
              label={<span className="text-xs text-ink/80">Categorie</span>}
              rules={[{ required: true }]}
            >
              <Select
                placeholder="Alege categoria"
                popupRender={(menu) => (
                  <>
                    {menu}
                    <div className="flex gap-2 p-2 border-t border-ink/10">
                      <Input
                        size="small"
                        placeholder="Categorie nouă"
                        value={newCategoryName}
                        onChange={(e) => setNewCategoryName(e.target.value)}
                        onKeyDown={(e) => e.stopPropagation()}
                      />
                      <Button size="small" icon={<PlusOutlined />} onClick={handleCreateCategory}>
                        Adaugă
                      </Button>
                    </div>
                  </>
                )}
              >
                {categories.map((cat) => (
                  <Select.Option key={cat.id} value={cat.id}>
                    {cat.name}
                  </Select.Option>
                ))}
              </Select>
            </Form.Item>

            <Form.Item
              name="priceAmount"
              label={<span className="text-xs text-ink/80">Preț (RON)</span>}
              rules={[{ required: true, message: 'Introduceți prețul' }]}
            >
              <InputNumber min={0} className="w-full" />
            </Form.Item>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs text-ink/80">
              Fișier video (.mp4 H.264 recomandat, se redă în toate browserele)
            </label>
            <input
              key={`video-${drawerKey}`}
              type="file"
              accept=".mp4,.m4v,.webm,.mov,video/*"
              onChange={(e) => setVideoFile(e.target.files?.[0] || null)}
              className="block w-full text-xs text-ink/80 file:mr-3 file:rounded-lg file:border-0 file:bg-ink file:px-3 file:py-1.5 file:text-cream"
            />
            {editingVideo && (
              <p className="text-[11px] text-muted/80">
                {editingVideo.bunnyVideoId
                  ? 'Filmul e încărcat pe Bunny Stream. Alege un fișier doar ca să-l înlocuiești.'
                  : 'Nu există fișier încărcat încă.'}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs text-ink/80">Imagine copertă (.jpg, .png, .webp)</label>
            <input
              key={`thumb-${drawerKey}`}
              type="file"
              accept=".jpg,.jpeg,.png,.webp,image/*"
              onChange={(e) => setThumbFile(e.target.files?.[0] || null)}
              className="block w-full text-xs text-ink/80 file:mr-3 file:rounded-lg file:border-0 file:bg-ink file:px-3 file:py-1.5 file:text-cream"
            />
          </div>

          <Form.Item
            name="isPublished"
            label={<span className="text-xs text-ink/80">Publicat în Catalog</span>}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>

          {uploadStatus && (
            <div className="text-xs text-ink/80 font-mono">Se încarcă… {uploadStatus}</div>
          )}

          <div className="pt-4 flex items-center justify-end gap-3 border-t border-ink/10">
            <Button onClick={() => setIsDrawerOpen(false)} disabled={isSubmitting}>Anulează</Button>
            <Button
              type="primary"
              htmlType="submit"
              loading={isSubmitting}
              className="bg-ink text-cream hover:!bg-ink-soft hover:!text-cream border-none"
            >
              {editingVideo ? 'Salvează modificările' : 'Creează videoclip'}
            </Button>
          </div>
        </Form>
      </Drawer>

      {/* Test Email Modal */}
      <Modal
        title="Trimite Email de Test (SMTP)"
        open={isTestEmailModalOpen}
        onCancel={() => setIsTestEmailModalOpen(false)}
        footer={null}
        centered
        width={420}
      >
        <div className="py-2 space-y-4">
          <p className="text-xs text-muted">
            Verifică livrarea în timp real a mesajelor prin serverul SMTP configurat.
          </p>

          <div>
            <label className="block text-xs text-ink/80 mb-1.5 font-medium">
              Adresă Email Destinatar
            </label>
            <Input
              type="email"
              placeholder="ex: tu@firma.ro"
              value={testRecipient}
              onChange={(e) => setTestRecipient(e.target.value)}
              className="h-10 rounded-lg"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-ink/10">
            <Button onClick={() => setIsTestEmailModalOpen(false)}>Anulează</Button>
            <Button
              type="primary"
              icon={<SendOutlined />}
              loading={isSendingTest}
              onClick={handleSendTestEmail}
              className="bg-ink text-cream hover:!bg-ink-soft hover:!text-cream border-none font-medium text-xs h-9 rounded-lg"
            >
              Trimite Test
            </Button>
          </div>
        </div>
      </Modal>

      {/* Email Preview Modal */}
      {previewEmail && (
        <Modal
          title={
            <div className="flex items-center justify-between pr-6">
              <span className="text-sm font-semibold text-ink truncate max-w-sm">
                {previewEmail.subject}
              </span>
              <Tag color={previewEmail.status === 'SENT' ? 'success' : 'error'} className="text-[10px]">
                {previewEmail.status}
              </Tag>
            </div>
          }
          open={true}
          onCancel={() => setPreviewEmail(null)}
          footer={null}
          centered
          width={640}
        >
          <div className="py-2 space-y-4">
            <div className="p-3 rounded-lg bg-cream border border-ink/10 text-xs space-y-1">
              <div className="flex justify-between">
                <span className="text-muted/80">Către:</span>
                <span className="text-ink font-medium">{previewEmail.to}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted/80">Dată expediere:</span>
                <span className="text-ink/80">
                  {new Date(previewEmail.sentAt).toLocaleString('ro-RO')}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted/80">Tip șablon:</span>
                <span className="text-ink/80 font-mono">{previewEmail.type}</span>
              </div>
            </div>

            {previewEmail.error && (
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-700 text-xs">
                {previewEmail.error}
              </div>
            )}

            <div className="border border-ink/15 rounded-xl overflow-hidden bg-sand max-h-[480px] overflow-y-auto">
              <iframe
                title="Email Preview"
                srcDoc={previewEmail.html}
                className="w-full h-[460px] border-none bg-sand"
                sandbox=""
              />
            </div>

            <div className="flex justify-end pt-2 border-t border-ink/10">
              <Button onClick={() => setPreviewEmail(null)}>Închide</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};
