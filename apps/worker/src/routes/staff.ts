import { Hono } from 'hono';
import {
  getStaffMembers,
  getStaffById,
  createStaffMember,
  updateStaffMember,
  regenerateStaffApiKey,
  countActiveStaffByRole,
} from '@line-crm/db';
import type { StaffMember } from '@line-crm/db';
import { requireRole } from '../middleware/role-guard.js';
import type { Env } from '../index.js';

const staff = new Hono<Env>();

function maskApiKey(key: string): string {
  return `lh_****${key.slice(-4)}`;
}

function serializeStaff(row: StaffMember, masked = true) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    apiKey: masked ? maskApiKey(row.api_key) : row.api_key,
    isActive: Boolean(row.is_active),
    workArea: row.work_area ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// GET /api/staff/me — any authenticated user (MUST be before /:id)
//
// ⚠️ requireRole を付けないこと。管理画面のログインはこのルートで API キーを検証しており
//    （apps/web/src/app/login/page.tsx）、ロール制限を掛けると弱いロールがログイン不能になる。
//    実際に旧実装が検証に使っていた /api/friends/count に認可を足した時、
//    撮影スタッフ(role=staff)が全員締め出された（2026-08-15〜08-18）。
staff.get('/api/staff/me', async (c) => {
  try {
    const currentStaff = c.get('staff');

    // env-owner: return minimal info
    if (currentStaff.id === 'env-owner') {
      return c.json({
        success: true,
        data: {
          id: 'env-owner',
          name: 'Owner',
          role: 'owner',
          email: null,
        },
      });
    }

    const member = await getStaffById(c.env.DB, currentStaff.id);
    if (!member) {
      return c.json({ success: false, error: 'Staff member not found' }, 404);
    }

    return c.json({
      success: true,
      data: {
        id: member.id,
        name: member.name,
        role: member.role,
        email: member.email,
        workArea: member.work_area ?? null,
      },
    });
  } catch (err) {
    console.error('GET /api/staff/me error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/staff — owner/manager は全件。撮影スタッフ(staff)は自分のレコードのみ。
//   撮影スタッフがシフト管理画面で「自分の行」を描画して自己シフトを登録できるようにするため、
//   staff ロールには自分1件だけ返す（全スタッフ閲覧は従来どおり owner/manager のみ）。
staff.get('/api/staff', async (c) => {
  try {
    const cur = c.get('staff');
    if (cur?.role === 'staff') {
      const me = await getStaffById(c.env.DB, cur.id);
      return c.json({ success: true, data: me ? [serializeStaff(me, true)] : [] });
    }
    if (cur?.role !== 'owner' && cur?.role !== 'manager') {
      return c.json({ success: false, error: 'この操作にはowner権限が必要です' }, 403);
    }
    const members = await getStaffMembers(c.env.DB);
    return c.json({ success: true, data: members.map((m) => serializeStaff(m, true)) });
  } catch (err) {
    console.error('GET /api/staff error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/staff/:id — owner/manager. Get staff detail with masked key.
staff.get('/api/staff/:id', requireRole('owner', 'manager'), async (c) => {
  try {
    const id = c.req.param('id')!;
    const member = await getStaffById(c.env.DB, id);
    if (!member) {
      return c.json({ success: false, error: 'Staff member not found' }, 404);
    }
    return c.json({ success: true, data: serializeStaff(member, true) });
  } catch (err) {
    console.error('GET /api/staff/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/staff — owner/manager. Create staff. Returns full API key (one-time visible).
// manager cannot create owner role (would be self-elevation).
staff.post('/api/staff', requireRole('owner', 'manager'), async (c) => {
  try {
    const body = await c.req.json<{ name: string; email?: string; role: string; workArea?: string | null }>();
    const currentStaff = c.get('staff');

    if (!body.name) {
      return c.json({ success: false, error: 'name is required' }, 400);
    }

    const validRoles = ['owner', 'admin', 'manager', 'staff'] as const;
    if (!body.role || !validRoles.includes(body.role as (typeof validRoles)[number])) {
      return c.json({ success: false, error: 'role must be owner, admin, manager, or staff' }, 400);
    }

    // 撮影スタッフ限定運用: マネージャーは「撮影スタッフ」ロールのユーザーのみ追加できる。
    if (currentStaff.role === 'manager' && body.role !== 'staff') {
      return c.json({ success: false, error: 'マネージャーは撮影スタッフ権限のユーザーのみ追加できます' }, 403);
    }

    const member = await createStaffMember(c.env.DB, {
      name: body.name,
      email: body.email ?? null,
      role: body.role as 'owner' | 'admin' | 'manager' | 'staff',
      // 稼働エリアは撮影スタッフのみ意味を持つ（他ロールは無視して null）。
      workArea: body.role === 'staff' ? (body.workArea ?? null) : null,
    });

    // Return full (unmasked) API key one-time
    return c.json({ success: true, data: serializeStaff(member, false) }, 201);
  } catch (err) {
    console.error('POST /api/staff error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PATCH /api/staff/:id — owner/manager. Update staff.
// manager cannot edit owner records and cannot promote anyone to owner.
staff.patch('/api/staff/:id', requireRole('owner', 'manager'), async (c) => {
  try {
    const id = c.req.param('id')!;
    const currentStaff = c.get('staff');
    const body = await c.req.json<{
      name?: string;
      email?: string | null;
      role?: string;
      isActive?: boolean;
      workArea?: string | null;
    }>();

    const validRoles = ['owner', 'admin', 'manager', 'staff'] as const;
    if (body.role !== undefined && !validRoles.includes(body.role as (typeof validRoles)[number])) {
      return c.json({ success: false, error: 'role must be owner, admin, manager, or staff' }, 400);
    }

    // Prevent removing the last active owner
    const target = await getStaffById(c.env.DB, id);
    if (!target) {
      return c.json({ success: false, error: 'Staff member not found' }, 404);
    }
    if (currentStaff.role === 'manager') {
      // マネージャーは自分より上位（owner/admin）および他のマネージャーの行を編集できない。
      // 対象は撮影スタッフ(staff)のみ。以前は owner だけを守っており、admin を staff へ降格・
      // 無効化できる権限昇格の穴があった。
      if (target.role !== 'staff') {
        return c.json({ success: false, error: 'マネージャーは撮影スタッフのみ編集できます' }, 403);
      }
      // 撮影スタッフ限定運用: マネージャーはロールを「撮影スタッフ」以外へ変更できない
      // （staff 作成→昇格 による権限回避を防ぐ）。
      if (body.role !== undefined && body.role !== 'staff') {
        return c.json({ success: false, error: 'マネージャーは撮影スタッフ権限のみ設定できます' }, 403);
      }
    }
    if (target.role === 'owner' && target.is_active === 1) {
      const willLoseOwner =
        (body.role !== undefined && body.role !== 'owner') ||
        body.isActive === false;
      if (willLoseOwner) {
        const ownerCount = await countActiveStaffByRole(c.env.DB, 'owner');
        if (ownerCount <= 1) {
          return c.json({ success: false, error: 'オーナーは最低1人必要です' }, 400);
        }
      }
    }

    const updated = await updateStaffMember(c.env.DB, id, {
      name: body.name,
      email: body.email,
      role: body.role as 'owner' | 'admin' | 'manager' | 'staff' | undefined,
      is_active: body.isActive !== undefined ? (body.isActive ? 1 : 0) : undefined,
      workArea: body.workArea,
    });

    if (!updated) {
      return c.json({ success: false, error: 'Staff member not found' }, 404);
    }

    return c.json({ success: true, data: serializeStaff(updated, true) });
  } catch (err) {
    console.error('PATCH /api/staff/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/staff/:id — owner/manager. Cannot delete self. Must keep at least 1 owner.
// manager cannot delete owner records.
staff.delete('/api/staff/:id', requireRole('owner', 'manager'), async (c) => {
  try {
    const id = c.req.param('id')!;
    const currentStaff = c.get('staff');

    if (id === currentStaff.id) {
      return c.json({ success: false, error: '自分自身は削除できません' }, 400);
    }

    const target = await getStaffById(c.env.DB, id);
    if (!target) {
      return c.json({ success: false, error: 'Staff member not found' }, 404);
    }

    // マネージャーは撮影スタッフ(staff)のみ削除可。以前は owner だけを守っており、
    // admin/他manager を削除できた（アカウントロックアウト）。
    if (currentStaff.role === 'manager' && target.role !== 'staff') {
      return c.json({ success: false, error: 'マネージャーは撮影スタッフのみ削除できます' }, 403);
    }

    if (target.role === 'owner' && target.is_active === 1) {
      const ownerCount = await countActiveStaffByRole(c.env.DB, 'owner');
      if (ownerCount <= 1) {
        return c.json({ success: false, error: 'オーナーは最低1人必要です' }, 400);
      }
    }

    // BOXIV: cascade clean up FK references that lack ON DELETE clauses
    // (booking_requests / staff_availability are BOXIV-only tables added in
    // migration 014_booking_system.sql). Without this, deleting a staff member
    // who has any availability slot or booking association fails with FK constraint error.
    //
    // Order matters: booking_requests.slot_id → staff_availability(id) is itself
    // a FK without ON DELETE. So we must NULL slot_id BEFORE deleting the slots.
    await c.env.DB.batch([
      c.env.DB.prepare(
        'UPDATE booking_requests SET slot_id = NULL WHERE slot_id IN (SELECT id FROM staff_availability WHERE staff_id = ?)',
      ).bind(id),
      c.env.DB.prepare('DELETE FROM staff_availability WHERE staff_id = ?').bind(id),
      c.env.DB.prepare('UPDATE booking_requests SET staff_id = NULL WHERE staff_id = ?').bind(id),
      c.env.DB.prepare('UPDATE booking_requests SET approved_by = NULL WHERE approved_by = ?').bind(id),
      c.env.DB.prepare('DELETE FROM staff_members WHERE id = ?').bind(id),
    ]);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/staff/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/staff/:id/regenerate-key — owner/manager. Return new API key.
// manager cannot regenerate owner's keys.
staff.post('/api/staff/:id/regenerate-key', requireRole('owner', 'manager'), async (c) => {
  try {
    const id = c.req.param('id')!;
    const currentStaff = c.get('staff');
    const exists = await getStaffById(c.env.DB, id);
    if (!exists) {
      return c.json({ success: false, error: 'Staff member not found' }, 404);
    }
    // マネージャーは撮影スタッフ(staff)のみキー再生成可。以前は owner だけを守っており、
    // admin のキーを再生成して受け取り → admin 権限を奪取できる昇格の穴があった。
    if (currentStaff.role === 'manager' && exists.role !== 'staff') {
      return c.json({ success: false, error: 'マネージャーは撮影スタッフのキーのみ再生成できます' }, 403);
    }
    const newKey = await regenerateStaffApiKey(c.env.DB, id);
    return c.json({ success: true, data: { apiKey: newKey } });
  } catch (err) {
    console.error('POST /api/staff/:id/regenerate-key error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { staff };
