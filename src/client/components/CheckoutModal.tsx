import React, { useEffect, useState } from 'react';
import { Modal, Button, Checkbox, Form, Input, Radio, Select } from 'antd';
import { LockOutlined, CreditCardOutlined } from '@ant-design/icons';
import { Video } from '../../types/index.ts';
import { COUNTRIES, RO_COUNTIES, isValidRoCui, validateBilling } from '../../types/billing.ts';
import { useAuth } from '../context/AuthContext.tsx';

interface CheckoutModalProps {
  video: Video;
  onClose: () => void;
}

const fieldLabel = (text: string) => <span className="text-xs text-ink/80">{text}</span>;

export const CheckoutModal: React.FC<CheckoutModalProps> = ({ video, onClose }) => {
  const { user } = useAuth();
  const [form] = Form.useForm();
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [acceptedTerms, setAcceptedTerms] = useState<boolean>(false);

  const buyerType = Form.useWatch('type', form) || 'PF';
  const country = Form.useWatch('country', form) || 'RO';
  const isRomania = country === 'RO';

  // The details of the last checkout come back as prefill, so the buyer only has to check them
  useEffect(() => {
    let active = true;
    fetch('/api/account/billing')
      .then(res => res.json())
      .then(data => {
        if (active && data?.billing) form.setFieldsValue(data.billing);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [form]);

  // Creates a Stripe Checkout session and redirects to Stripe's hosted payment page
  const handlePayWithStripe = async () => {
    if (!acceptedTerms || isProcessing) return;

    setError(null);

    let values: any;
    try {
      values = await form.validateFields();
    } catch {
      return; // antd already marks the invalid fields
    }

    // Same validation as the server, so the buyer sees the problem before leaving for Stripe
    const billing = validateBilling(values);
    if (!billing.ok) {
      setError(billing.error);
      return;
    }

    setIsProcessing(true);

    try {
      const res = await fetch(`/api/payments/checkout/${video.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acceptedTerms: true, billing: billing.value }),
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
      width={720}
      style={{ maxWidth: 'calc(100vw - 24px)' }}
      destroyOnHidden
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

        {/* Billing details — they go on the FGO invoice */}
        <Form
          form={form}
          layout="vertical"
          initialValues={{ type: 'PF', country: 'RO' }}
          disabled={isProcessing}
          className="p-3 rounded-xl bg-cream/80 border border-ink/10 space-y-3"
        >
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
            <h4 className="text-xs font-semibold text-ink">Date de facturare</h4>
            {user?.email && (
              <span className="text-[11px] text-muted">Factura se trimite pe {user.email}</span>
            )}
          </div>

          <Form.Item name="type" label={fieldLabel('Tip client')} className="!mb-0">
            <Radio.Group>
              <Radio value="PF">Persoană fizică</Radio>
              <Radio value="PJ">Persoană juridică</Radio>
            </Radio.Group>
          </Form.Item>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-2">
            <Form.Item
              name="name"
              label={fieldLabel(buyerType === 'PJ' ? 'Denumire firmă' : 'Nume și prenume')}
              rules={[
                { required: true, message: 'Completează numele.' },
                { min: 2, message: 'Numele trebuie să aibă cel puțin 2 caractere.' },
                { max: 255, message: 'Numele poate avea cel mult 255 de caractere.' },
              ]}
              className="!mb-0"
            >
              <Input placeholder={buyerType === 'PJ' ? 'ex: Firma SRL' : 'ex: Ion Popescu'} />
            </Form.Item>

            {buyerType === 'PJ' && (
              <Form.Item
                name="cui"
                label={fieldLabel('CUI')}
                rules={[
                  {
                    validator: (_: any, value: string) => {
                      const cui = String(value ?? '').trim();
                      if (!cui) return Promise.reject(new Error('CUI-ul este obligatoriu pentru persoana juridică.'));
                      if (cui.length > 128) return Promise.reject(new Error('CUI-ul poate avea cel mult 128 de caractere.'));
                      if (isRomania && !isValidRoCui(cui)) return Promise.reject(new Error('CUI invalid.'));
                      return Promise.resolve();
                    },
                  },
                ]}
                className="!mb-0"
              >
                <Input placeholder="ex: RO12345678" />
              </Form.Item>
            )}

            {buyerType === 'PJ' && (
              <Form.Item
                name="regCom"
                label={fieldLabel('Nr. Reg. Com. (opțional)')}
                rules={[{ max: 128, message: 'Numărul poate avea cel mult 128 de caractere.' }]}
                className="!mb-0"
              >
                <Input placeholder="ex: J40/1234/2020" />
              </Form.Item>
            )}

            <Form.Item
              name="country"
              label={fieldLabel('Țară')}
              rules={[{ required: true, message: 'Alege țara.' }]}
              className="!mb-0"
            >
              <Select
                showSearch
                optionFilterProp="label"
                options={COUNTRIES.map(item => ({ value: item.code, label: item.name }))}
              />
            </Form.Item>

            {isRomania && (
              <Form.Item
                name="county"
                label={fieldLabel('Județ')}
                rules={[{ required: true, message: 'Alege județul.' }]}
                className="!mb-0"
              >
                <Select
                  showSearch
                  optionFilterProp="label"
                  placeholder="Alege județul"
                  options={RO_COUNTIES.map(item => ({ value: item.code, label: item.name }))}
                />
              </Form.Item>
            )}

            <Form.Item
              name="city"
              label={fieldLabel('Localitate')}
              rules={[
                { required: true, message: 'Completează localitatea.' },
                { max: 100, message: 'Localitatea poate avea cel mult 100 de caractere.' },
              ]}
              className="!mb-0"
            >
              <Input placeholder="ex: București" />
            </Form.Item>

            <Form.Item
              name="phone"
              label={fieldLabel('Telefon (opțional)')}
              rules={[
                { max: 30, message: 'Telefonul poate avea cel mult 30 de caractere.' },
                {
                  pattern: /^[0-9+ ()-]+$/,
                  message: 'Telefonul poate conține doar cifre, +, spații, paranteze și cratime.',
                },
              ]}
              className="!mb-0"
            >
              <Input placeholder="ex: +40 721 123 456" />
            </Form.Item>

            <Form.Item
              name="address"
              label={fieldLabel('Adresă')}
              rules={[
                { required: true, message: 'Completează adresa.' },
                { min: 3, message: 'Adresa trebuie să aibă cel puțin 3 caractere.' },
                { max: 500, message: 'Adresa poate avea cel mult 500 de caractere.' },
              ]}
              className="!mb-0 sm:col-span-2"
            >
              <Input placeholder="ex: Str. Exemplu nr. 1, ap. 2" />
            </Form.Item>
          </div>
        </Form>

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
