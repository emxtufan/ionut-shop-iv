import React, { useState } from 'react';
import { Modal, Form, Input, Button, Tabs, notification } from 'antd';
import { MailOutlined, LockOutlined, UserOutlined } from '@ant-design/icons';
import { useAuth } from '../context/AuthContext.tsx';

interface AuthModalProps {
  initialMode?: 'login' | 'register';
  onClose: () => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({ initialMode = 'login', onClose }) => {
  const { login, register } = useAuth();
  const [activeTab, setActiveTab] = useState<string>(initialMode);
  const [isLoading, setIsLoading] = useState<boolean>(false);

  // Forgot password flow (login tab only)
  const [showForgotPassword, setShowForgotPassword] = useState<boolean>(false);
  const [forgotPasswordMessage, setForgotPasswordMessage] = useState<string | null>(null);

  // Handle Login
  const handleLoginSubmit = async (values: any) => {
    setIsLoading(true);
    try {
      await login(values.identifier, values.password);
      notification.success({ message: 'Autentificare reușită' });
      onClose();
    } catch (err: any) {
      notification.error({
        message: 'Eroare autentificare',
        description: err.message || 'Verificați datele introduse.',
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Handle Register
  const handleRegisterSubmit = async (values: any) => {
    setIsLoading(true);
    try {
      await register(values.email, values.username, values.password);
      notification.success({ message: 'Cont creat cu succes' });
      onClose();
    } catch (err: any) {
      notification.error({
        message: 'Eroare înregistrare',
        description: err.message,
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Handle Forgot Password
  const handleForgotPasswordSubmit = async (values: any) => {
    setIsLoading(true);
    setForgotPasswordMessage(null);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: values.email }),
      });

      const data = await res.json();
      setForgotPasswordMessage(
        data.message || 'Dacă adresa există, vei primi un email cu instrucțiuni.'
      );
    } catch (err: any) {
      notification.error({
        message: 'Eroare',
        description: 'Nu s-a putut trimite solicitarea. Încearcă din nou.',
      });
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
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          centered
          items={[
            {
              key: 'login',
              label: 'Autentificare',
              children: (
                <div className="pt-4 space-y-4">
                  {showForgotPassword ? (
                    <>
                      <Form layout="vertical" onFinish={handleForgotPasswordSubmit} requiredMark={false}>
                        <p className="text-xs text-muted mb-3">
                          Introdu adresa de email a contului și îți trimitem un link pentru setarea unei parole noi.
                        </p>

                        <Form.Item
                          name="email"
                          rules={[
                            { required: true, message: 'Introduceți adresa de email' },
                            { type: 'email', message: 'Email invalid' },
                          ]}
                        >
                          <Input
                            prefix={<MailOutlined className="text-muted/80 mr-1.5" />}
                            placeholder="Email"
                            size="large"
                          />
                        </Form.Item>

                        <Form.Item className="pt-2 mb-2">
                          <Button
                            type="primary"
                            htmlType="submit"
                            loading={isLoading}
                            block
                            size="large"
                            className="rounded-xl font-medium bg-ink text-cream hover:!bg-ink-soft hover:!text-cream border-none"
                          >
                            Trimite linkul de resetare
                          </Button>
                        </Form.Item>
                      </Form>

                      {forgotPasswordMessage && (
                        <div className="p-3 rounded-lg bg-cream border border-ink/10 text-xs text-muted">
                          {forgotPasswordMessage}
                        </div>
                      )}

                      <Button
                        type="text"
                        block
                        className="text-xs text-muted hover:text-ink"
                        onClick={() => {
                          setForgotPasswordMessage(null);
                          setShowForgotPassword(false);
                        }}
                      >
                        Înapoi la autentificare
                      </Button>
                    </>
                  ) : (
                    <>
                      <Form layout="vertical" onFinish={handleLoginSubmit} requiredMark={false}>
                        <Form.Item
                          name="identifier"
                          rules={[{ required: true, message: 'Introduceți email-ul sau username-ul' }]}
                        >
                          <Input
                            prefix={<MailOutlined className="text-muted/80 mr-1.5" />}
                            placeholder="Email sau username"
                            size="large"
                          />
                        </Form.Item>

                        <Form.Item
                          name="password"
                          rules={[{ required: true, message: 'Introduceți parola' }]}
                        >
                          <Input.Password
                            prefix={<LockOutlined className="text-muted/80 mr-1.5" />}
                            placeholder="Parolă"
                            size="large"
                          />
                        </Form.Item>

                        <div className="text-right -mt-1 mb-1">
                          <button
                            type="button"
                            onClick={() => setShowForgotPassword(true)}
                            className="text-xs text-muted hover:text-ink underline underline-offset-2 cursor-pointer bg-transparent border-none p-0"
                          >
                            Ai uitat parola?
                          </button>
                        </div>

                        <Form.Item className="pt-2 mb-2">
                          <Button
                            type="primary"
                            htmlType="submit"
                            loading={isLoading}
                            block
                            size="large"
                            className="rounded-xl font-medium bg-ink text-cream hover:!bg-ink-soft hover:!text-cream border-none"
                          >
                            Autentificare
                          </Button>
                        </Form.Item>
                      </Form>
                    </>
                  )}
                </div>
              ),
            },
            {
              key: 'register',
              label: 'Creează cont',
              children: (
                <div className="pt-4 space-y-4">
                  <Form layout="vertical" onFinish={handleRegisterSubmit} requiredMark={false}>
                    <Form.Item
                      name="username"
                      rules={[{ required: true, message: 'Introduceți username-ul dorit' }]}
                    >
                      <Input
                        prefix={<UserOutlined className="text-muted/80 mr-1.5" />}
                        placeholder="Username"
                        size="large"
                      />
                    </Form.Item>

                    <Form.Item
                      name="email"
                      rules={[
                        { required: true, message: 'Introduceți adresa de email' },
                        { type: 'email', message: 'Email invalid' },
                      ]}
                    >
                      <Input
                        prefix={<MailOutlined className="text-muted/80 mr-1.5" />}
                        placeholder="Email"
                        size="large"
                      />
                    </Form.Item>

                    <Form.Item
                      name="password"
                      rules={[{ required: true, message: 'Minim 8 caractere', min: 8 }]}
                    >
                      <Input.Password
                        prefix={<LockOutlined className="text-muted/80 mr-1.5" />}
                        placeholder="Parolă (min. 8 caractere)"
                        size="large"
                      />
                    </Form.Item>

                    <Form.Item className="pt-2 mb-2">
                      <Button
                        type="primary"
                        htmlType="submit"
                        loading={isLoading}
                        block
                        size="large"
                        className="rounded-xl font-medium bg-ink text-cream hover:!bg-ink-soft hover:!text-cream border-none"
                      >
                        Creează cont
                      </Button>
                    </Form.Item>
                  </Form>
                </div>
              ),
            },
          ]}
        />
      </div>
    </Modal>
  );
};
