// ==============================================================================
// IV Concept VOD - Admin: Categories Management Tab
// ==============================================================================

import React, { useState, useEffect } from 'react';
import { Table, Input, Button, Popconfirm, Modal, message } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { Category } from '../../types/index.ts';

interface AdminCategoriesTabProps {
  // Lets the parent reload the category list used by the video form
  onCategoriesChanged: () => void;
}

export const AdminCategoriesTab: React.FC<AdminCategoriesTabProps> = ({ onCategoriesChanged }) => {
  const [categories, setCategories] = useState<Category[]>([]);
  const [newName, setNewName] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);

  // Rename modal
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [editingName, setEditingName] = useState<string>('');

  const loadCategories = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/categories');
      const data = await res.json();
      if (!res.ok) {
        message.error(data.message || 'Eroare la încărcarea categoriilor.');
        return;
      }
      setCategories(data.categories || []);
    } catch {
      message.error('Eroare de conexiune la încărcarea categoriilor.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadCategories();
  }, []);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) {
      message.warning('Introduceți numele categoriei.');
      return;
    }

    setIsSaving(true);
    try {
      const res = await fetch('/api/admin/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) {
        // 409 CATEGORY_EXISTS comes back with its own Romanian message
        message.error(data.message);
        return;
      }
      setNewName('');
      message.success('Categoria a fost adăugată.');
      await loadCategories();
      onCategoriesChanged();
    } catch {
      message.error('Eroare de conexiune.');
    } finally {
      setIsSaving(false);
    }
  };

  const openRename = (category: Category) => {
    setEditingCategory(category);
    setEditingName(category.name);
  };

  const closeRename = () => {
    setEditingCategory(null);
    setEditingName('');
  };

  const handleRename = async () => {
    if (!editingCategory) return;

    const name = editingName.trim();
    if (!name) {
      message.warning('Introduceți numele categoriei.');
      return;
    }

    setIsSaving(true);
    try {
      const res = await fetch(`/api/admin/categories/${editingCategory.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) {
        // 409 CATEGORY_EXISTS
        message.error(data.message);
        return;
      }
      message.success('Categoria a fost redenumită.');
      closeRename();
      await loadCategories();
      onCategoriesChanged();
    } catch {
      message.error('Eroare de conexiune.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (category: Category) => {
    try {
      const res = await fetch(`/api/admin/categories/${category.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        // 409 CATEGORY_HAS_VIDEOS: the category still contains movies
        message.error(data.message);
        return;
      }
      message.success('Categoria a fost ștearsă.');
      await loadCategories();
      onCategoriesChanged();
    } catch {
      message.error('Eroare de conexiune.');
    }
  };

  const columns = [
    {
      title: 'Nume',
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => <span className="text-xs font-medium text-ink">{name}</span>,
    },
    {
      title: 'Slug',
      dataIndex: 'slug',
      key: 'slug',
      width: 220,
      render: (slug: string) => <span className="text-xs font-mono text-muted">{slug}</span>,
    },
    {
      title: 'Filme publicate',
      dataIndex: 'videoCount',
      key: 'videoCount',
      width: 150,
      render: (videoCount?: number) => (
        <span className="text-xs font-semibold text-ink">{videoCount ?? 0}</span>
      ),
    },
    {
      title: 'Acțiuni',
      key: 'actions',
      width: 130,
      render: (_: any, record: Category) => (
        <div className="flex items-center gap-2">
          <Button
            type="text"
            size="small"
            icon={<EditOutlined className="text-muted hover:text-ink" />}
            onClick={() => openRename(record)}
          />
          <Popconfirm
            title="Ștergeți categoria?"
            description="Doar categoriile fără filme pot fi șterse."
            okText="Șterge"
            cancelText="Anulează"
            okButtonProps={{ danger: true }}
            onConfirm={() => handleDelete(record)}
          >
            <Button type="text" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </div>
      ),
    },
  ];

  return (
    <div className="pt-2 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Input
            placeholder="Nume categorie nouă"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onPressEnter={handleCreate}
            className="max-w-xs"
          />
          <Button
            type="primary"
            icon={<PlusOutlined />}
            loading={isSaving}
            onClick={handleCreate}
            className="bg-ink text-cream hover:!bg-ink-soft hover:!text-cream border-none text-xs font-medium"
          >
            Adaugă
          </Button>
        </div>
        <span className="text-xs text-muted">{categories.length} categorii</span>
      </div>

      <Table
        dataSource={categories}
        columns={columns}
        rowKey="id"
        loading={isLoading}
        pagination={{ pageSize: 10 }}
        className="border border-ink/10 rounded-xl overflow-hidden"
      />

      <Modal
        title="Redenumire categorie"
        open={!!editingCategory}
        onCancel={closeRename}
        onOk={handleRename}
        okText="Salvează"
        cancelText="Anulează"
        confirmLoading={isSaving}
        destroyOnHidden
      >
        <Input
          value={editingName}
          onChange={(e) => setEditingName(e.target.value)}
          onPressEnter={handleRename}
          placeholder="Numele categoriei"
        />
      </Modal>
    </div>
  );
};
