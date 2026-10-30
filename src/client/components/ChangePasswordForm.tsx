// ==============================================================================
// IV Concept VOD - Change Password Form
// Used both in "Setări" (admin) and in "Datele mele" (account page).
// ==============================================================================

import React, { useState } from 'react';
import { Form, Input, Button, message } from 'antd';
import { LockOutlined } from '@ant-design/icons';

export const ChangePasswordForm: React.FC = () => {
  const [form] = Form.useForm();
  const [isSaving, setIsSaving] = useState<boolean>(false);

  const handleSubmit = async (values: any) => {
    setIsSaving(true);
    try {
      const res = await fetch('/api/account/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword: values.currentPassword,
          newPassword: values.newPassword,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        message.error(data.message || 'Schimbarea parolei a eșuat.');
        return;
      }

      message.success(data.message || 'Parola a fost schimbată.');
      form.resetFields();
    } catch {
      message.error('Eroare de conexiune.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Form form={form} layout="vertical" onFinish={handleSubmit} requiredMark={false}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4">
        <Form.Item
          name="currentPassword"
          label={<span className="text-xs text-ink/80">Parola actuală</span>}
          rules={[{ required: true, message: 'Introduceți parola actuală' }]}
        >
          <Input.Password
            prefix={<LockOutlined className="text-muted/80 mr-1.5" />}
            placeholder="Parola actuală"
            autoComplete="current-password"
          />
        </Form.Item>

        <Form.Item
          name="newPassword"
          label={<span className="text-xs text-ink/80">Parola nouă</span>}
          rules={[
            { required: true, message: 'Introduceți parola nouă' },
            { min: 8, message: 'Minim 8 caractere' },
            { max: 128, message: 'Maxim 128 de caractere' },
          ]}
        >
          <Input.Password
            prefix={<LockOutlined className="text-muted/80 mr-1.5" />}
            placeholder="Parolă nouă (min. 8 caractere)"
            autoComplete="new-password"
          />
        </Form.Item>

        <Form.Item
          name="confirmPassword"
          dependencies={['newPassword']}
          label={<span className="text-xs text-ink/80">Confirmă parola nouă</span>}
          rules={[
            { required: true, message: 'Confirmați parola nouă' },
            ({ getFieldValue }) => ({
              validator(_: any, value: string) {
                if (!value || getFieldValue('newPassword') === value) return Promise.resolve();
                return Promise.reject(new Error('Parolele nu coincid'));
              },
            }),
          ]}
        >
          <Input.Password
            prefix={<LockOutlined className="text-muted/80 mr-1.5" />}
            placeholder="Confirmă parola nouă"
            autoComplete="new-password"
          />
        </Form.Item>
      </div>

      <p className="text-[11px] text-muted mb-3">
        După schimbare, celelalte dispozitive sunt deconectate.
      </p>

      <Button
        type="primary"
        htmlType="submit"
        loading={isSaving}
        className="h-10 text-xs font-semibold rounded-xl bg-ink text-cream hover:!bg-ink-soft hover:!text-cream border-none"
      >
        Schimbă parola
      </Button>
    </Form>
  );
};
