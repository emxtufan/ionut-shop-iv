import React, { useState } from 'react';
import { Modal, Button, Checkbox } from 'antd';
import { LockOutlined, CreditCardOutlined } from '@ant-design/icons';
import { Video } from '../../types/index.ts';

interface CheckoutModalProps {
  video: Video;
  onClose: () => void;
}

export const CheckoutModal: React.FC<CheckoutModalProps> = ({ video, onClose }) => {
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [acceptedTerms, setAcceptedTerms] = useState<boolean>(false);

  // Creates a Stripe Checkout session and redirects to Stripe's hosted payment page
  const handlePayWithStripe = async () => {
    if (!acceptedTerms) return;

    setIsProcessing(true);
    setError(null);

    try {
      const res = await fetch(`/api/payments/checkout/${video.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acceptedTerms: true }),
      });

      const data = await res.json();
      if (!res.ok || !data.checkoutUrl) {
        throw new Error(data.message || 'Inițializarea plății Stripe a eșuat.');
      }

      window.location.href = data.checkoutUrl;
    } catch (err: any) {
      setError(err.message);
      setIsProcessing(false);
    }
  };

  return (
    <Modal
      open={true}
      onCancel={onClose}
      footer={null}
      centered
      width={460}
      destroyOnClose
    >
      <div className="py-2 space-y-6">
        {/* Header Title */}
        <div className="space-y-1">
          <h3 className="text-lg font-semibold text-ink tracking-tight">
            Deblochează accesul
          </h3>
          <p className="text-xs text-muted">
            Plată unică, acces permanent la streaming pe toate dispozitivele.
          </p>
        </div>

        {/* Video Preview Card */}
        <div className="flex items-center gap-3.5 p-3 rounded-xl bg-cream border border-ink/10">
          <img
            src={video.thumbnailUrl}
            alt={video.title}
            className="w-20 aspect-video rounded-lg object-cover flex-shrink-0"
          />
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-medium text-ink truncate">
              {video.title}
            </h4>
            <div className="text-xs text-muted mt-0.5">
              Acces complet pe toate dispozitivele
            </div>
          </div>
          <div className="text-sm font-semibold text-ink whitespace-nowrap">
            {video.priceAmount} {video.currency}
          </div>
        </div>

        <div className="p-3 rounded-xl bg-cream/80 border border-ink/10 text-[11px] text-muted flex items-center gap-1.5">
          <LockOutlined className="text-xs text-emerald-700" />
          <span>Plata se face securizat pe pagina Stripe. Datele cardului nu ajung pe serverele noastre.</span>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-700 text-xs">
            {error}
          </div>
        )}

        {/* Consent — required before payment */}
        <div className="p-3 rounded-xl bg-cream/80 border border-ink/10">
          <Checkbox
            checked={acceptedTerms}
            disabled={isProcessing}
            onChange={e => setAcceptedTerms(e.target.checked)}
            className="items-start"
          >
            <span className="text-[11px] leading-relaxed text-muted">
              Sunt de acord cu{' '}
              <a
                href="/?page=terms"
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                className="text-ink underline hover:text-ink-soft"
              >
                Termenii și condițiile
              </a>{' '}
              și solicit accesul imediat la conținutul digital. Înțeleg că îmi pierd dreptul de retragere de 14 zile
              odată ce începe furnizarea.
            </span>
          </Checkbox>
        </div>

        {/* Action Buttons */}
        <div className="space-y-2.5 pt-2">
          <Button
            type="primary"
            block
            loading={isProcessing}
            disabled={!acceptedTerms || isProcessing}
            onClick={handlePayWithStripe}
            icon={<CreditCardOutlined />}
            className="h-11 rounded-xl text-sm font-semibold bg-ink text-cream hover:!bg-ink-soft hover:!text-cream border-none"
          >
            {isProcessing
              ? 'Redirecționare către Stripe...'
              : `Plătește • ${video.priceAmount} ${video.currency}`}
          </Button>

          <Button
            type="text"
            block
            onClick={onClose}
            disabled={isProcessing}
            className="text-xs text-muted hover:text-ink"
          >
            Anulează
          </Button>
        </div>
      </div>
    </Modal>
  );
};
