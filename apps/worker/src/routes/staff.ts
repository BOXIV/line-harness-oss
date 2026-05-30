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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// GET /api/staff/me — any authenticated user (MUST be before /:id)
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
      },
    });
  } catch (err) {
    console.error('GET /api/staff/me error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/staff — owner/manager. List all staff with masked API keys.
staff.get('/api/staff', requireRole('owner', 'manager'), async (c) => {
  try {
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
    const body = await c.req.json<{ name: string; email?: string; role: string }>();
    const currentStaff = c.get('staff');

    if (!body.name) {
      return c.json({ success: false, error: 'name is required' }, 400);
    }

    const validRoles = ['owner', 'admin', 'manager', 'staff'] as const;
    if (!body.role || !validRoles.includes(body.role as (typeof validRoles)[number])) {
      return c.json({ success: false, error: 'role must be owner, admin, manager, or staff' }, 400);
    }

    if (currentStaff.role === 'manager' && body.role === 'owner') {
      return c.json({ success: false, error: 'マネージャーはオーナーロールを付与できません' }, 403);
    }

    const member = await createStaffMember(c.env.DB, {
      name: body.name,
      email: body.email ?? null,
      role: body.role as 'owner' | 'admin' | 'manager' | 'staff',
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
      if (target.role === 'owner') {
        return c.json({ success: false, error: 'マネージャーはオーナーを編集できません' }, 403);
      }
      if (body.role === 'owner') {
        return c.json({ success: false, error: 'マネージャーはオーナーロールを付与できません' }, 403);
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

    if (currentStaff.role === 'manager' && target.role === 'owner') {
      return c.json({ success: false, error: 'マネージャーはオーナーを削除できません' }, 403);
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
    if (currentStaff.role === 'manager' && exists.role === 'owner') {
      return c.json({ success: false, error: 'マネージャーはオーナーのキーを再生成できません' }, 403);
    }
    const newKey = await regenerateStaffApiKey(c.env.DB, id);
    return c.json({ success: true, data: { apiKey: newKey } });
  } catch (err) {
    console.error('POST /api/staff/:id/regenerate-key error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { staff };
