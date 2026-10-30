import React, { useState } from 'react';
import { Modal, Form, Input, Button } from 'antd';
import { LockOutlined } from '@ant-design/icons';

interface ResetPasswordModalProps {
  token: string;
  onClose: () => void;
  onSuccess: (message: string) => void;
}

export const ResetPasswordModal: React.FC<ResetPasswordModalProps> = ({
  token,
  onClose,
  onSuccess,
}) => {
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Handle Reset Password
  const handleResetSubmit = async (values: any) => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: values.password }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        setErrorMessage(data.message || 'Linkul este invalid sau a expirat.');
        return;
      }

      onSuccess(data.message || 'Parola a fost actualizată cu succes.');
    } catch (err: any) {
      setErrorMessage('Nu s-a putut reseta parola. Încearcă din nou.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Modal
      open={true}
      onCancel={onClose}
      footer={null}
      centered
      width={420}
      destroyOnClose
    >
      <div className="py-2">
        <div className="space-y-1 mb-4">
          <h3 className="text-lg font-semibold text-ink tracking-tight">
            Setează o parolă nouă
          </h3>
          <p className="text-xs text-muted">
            Introdu noua parolă a contului tău pentru a finaliza resetarea.
          </p>
        </div>

        <Form layout="vertical" onFinish={handleResetSubmit} requiredMark={false}>
          <Form.Item
            name="password"
            rules={[
              { required: true, message: 'Introduceți parola nouă' },
              { min: 8, message: 'Minim 8 caractere' },
              { max: 128, message: 'Maxim 128 de caractere' },
            ]}
          >
            <Input.Password
              prefix={<LockOutlined className="text-muted/80 mr-1.5" />}
              placeholder="Parolă nouă (min. 8 caractere)"
              size="large"
            />
          </Form.Item>

          <Form.Item
            name="confirmPassword"
            dependencies={['password']}
            rules={[
              { required: true, message: 'Confirmați parola nouă' },
              ({ getFieldValue }) => ({
                validator(_: any, value: string) {
                  if (!value || getFieldValue('password') === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error('Parolele nu coincid'));
                },
              }),
            ]}
          >
            <Input.Password
              prefix={<LockOutlined className="text-muted/80 mr-1.5" />}
              placeholder="Confirmă parola nouă"
              size="large"
            />
          </Form.Item>

          {errorMessage && (
            <div className="p-3 mb-3 rounded-lg bg-cream border border-ink/10 text-xs text-muted">
              {errorMessage}
            </div>
          )}

          <Form.Item className="pt-2 mb-2">
            <Button
              type="primary"
              htmlType="submit"
              loading={isLoading}
              block
              size="large"
              className="rounded-xl font-medium bg-ink text-cream hover:!bg-ink-soft hover:!text-cream border-none"
            >
              Salvează parola nouă
            </Button>
          </Form.Item>
        </Form>
      </div>
    </Modal>
  );
};
