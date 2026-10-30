// ==============================================================================
// IV Concept VOD - Types shared by client and server (JSON shapes of the API)
// ==============================================================================

export type Role = 'USER' | 'ADMIN' | 'SUPER_ADMIN';

export type VideoStatus = 'UPLOADING' | 'PROCESSING' | 'READY' | 'FAILED';

export type PaymentStatus = 'PENDING' | 'PAID' | 'REFUNDED' | 'CHARGEBACK';

export type EntitlementStatus = 'ACTIVE' | 'REVOKED';

export type AuditSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface User {
  id: string;
  email: string;
  username: string;
  role: Role;
  isSuspended: boolean;
  suspendedReason?: string | null;
  failedLoginAttempts: number;
  lockoutUntil?: string | null;
  lastLoginAt?: string | null;
  lastLoginIp?: string | null;
  createdAt: string;
}

export interface Category {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  videoCount?: number;
}

export interface Video {
  id: string;
  title: string;
  slug: string;
  description: string;
  categoryId: string;
  category?: Category;
  tags: string[];
  priceAmount: number;
  currency: string;
  durationSeconds: number;
  thumbnailUrl: string;
  bunnyVideoId?: string | null;
  status: VideoStatus;
  isPublished: boolean;
  publishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  // Computed for current user
  isPurchased?: boolean;
  hasEntitlement?: boolean;
}

export interface Purchase {
  id: string;
  userId: string;
  videoId: string;
  paymentId?: string | null;
  invoiceId?: string;
  invoiceNumber?: string | null;
  amount: number;
  currency: string;
  status: PaymentStatus;
  createdAt: string;
  updatedAt: string;
  user?: Partial<User>;
  video?: Video;
  invoice?: Invoice | null;
}

export interface InvoiceItem {
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export interface Invoice {
  id: string;
  invoiceNumber: string | null;
  purchaseId: string;
  userId: string;
  buyerName: string;
  buyerEmail: string;
  sellerName: string;
  sellerCif: string;
  sellerAddress: string;
  items: InvoiceItem[];
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  totalAmount: number;
  currency: string;
  status: 'PAID' | 'REFUNDED';
  stripePaymentIntentId?: string | null;
  stripeInvoiceId?: string | null;
  stripeHostedInvoiceUrl?: string | null;
  issuedAt: string;
}

export type EmailType = 'WELCOME' | 'PURCHASE_CONFIRMATION' | 'STRIPE_INVOICE' | 'PASSWORD_RESET' | 'TEST';

export interface EmailLog {
  id: string;
  to: string;
  subject: string;
  type: EmailType;
  status: 'SENT' | 'FAILED';
  sentAt: string;
  html: string;
  error?: string | null;
  metadata?: Record<string, any> | null;
}

export interface PlaybackAuthorization {
  expiresAt: string;
  jti: string;
  embedUrl: string;
  watermark: {
    text: string;
    userId: string;
    sessionId: string;
    refreshIntervalSeconds: number;
  };
}

export interface AuditLog {
  id: string;
  eventType: string;
  severity: AuditSeverity;
  userId?: string | null;
  adminId?: string | null;
  videoId?: string | null;
  purchaseId?: string | null;
  ip: string;
  userAgent: string;
  device?: string | null;
  metadata?: Record<string, any> | null;
  createdAt: string;
  userEmail?: string;
  userName?: string;
}
