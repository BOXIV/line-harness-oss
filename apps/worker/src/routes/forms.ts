import { Hono } from 'hono';
import {
  getForms,
  getFormById,
  createForm,
  updateForm,
  deleteForm,
  getFormSubmissions,
  createFormSubmission,
  jstNow,
} from '@line-crm/db';
import { getFriendByLineUserId, getFriendById } from '@line-crm/db';
import { addTagToFriend, enrollFriendInScenario } from '@line-crm/db';
import type { Form as DbForm, FormSubmission as DbFormSubmission } from '@line-crm/db';
import { verifyLiffIdToken } from './liff.js';
import type { Env } from '../index.js';

const forms = new Hono<Env>();

// friends.metadata のうち他機能が「正」として読むキー。フォームの field 名が
// これと衝突しても submit 経由では書かない（公開エンドポイントからの連携破壊防止）。
const RESERVED_METADATA_KEYS = new Set([
  'notionLinks', // notion-friend-link.boxiv.ts の連携の正
  'notion', // 同・後方互換の写し
  'listing_price_notified', // listing-entry.boxiv.ts の二重通知抑止
  'buyer_link_notified', // 同上
  'preferred_hour', // step-delivery.ts の配信時刻
  'x_username', // liff.ts X Harness 連携
]);

function serializeForm(row: DbForm) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    fields: JSON.parse(row.fields || '[]') as unknown[],
    onSubmitTagId: row.on_submit_tag_id,
    onSubmitScenarioId: row.on_submit_scenario_id,
    saveToMetadata: Boolean(row.save_to_metadata),
    isActive: Boolean(row.is_active),
    submitCount: row.submit_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeSubmission(row: DbFormSubmission & { friend_name?: string | null }) {
  return {
    id: row.id,
    formId: row.form_id,
    friendId: row.friend_id,
    friendName: row.friend_name || null,
    data: JSON.parse(row.data || '{}') as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

// GET /api/forms — list all forms
forms.get('/api/forms', async (c) => {
  try {
    const items = await getForms(c.env.DB);
    return c.json({ success: true, data: items.map(serializeForm) });
  } catch (err) {
    console.error('GET /api/forms error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/forms/:id — get form
forms.get('/api/forms/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const form = await getFormById(c.env.DB, id);
    if (!form) {
      return c.json({ success: false, error: 'Form not found' }, 404);
    }
    return c.json({ success: true, data: serializeForm(form) });
  } catch (err) {
    console.error('GET /api/forms/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/forms — create form
forms.post('/api/forms', async (c) => {
  try {
    const body = await c.req.json<{
      name: string;
      description?: string | null;
      fields?: unknown[];
      onSubmitTagId?: string | null;
      onSubmitScenarioId?: string | null;
      saveToMetadata?: boolean;
    }>();

    if (!body.name) {
      return c.json({ success: false, error: 'name is required' }, 400);
    }

    const form = await createForm(c.env.DB, {
      name: body.name,
      description: body.description ?? null,
      fields: JSON.stringify(body.fields ?? []),
      onSubmitTagId: body.onSubmitTagId ?? null,
      onSubmitScenarioId: body.onSubmitScenarioId ?? null,
      saveToMetadata: body.saveToMetadata,
    });

    return c.json({ success: true, data: serializeForm(form) }, 201);
  } catch (err) {
    console.error('POST /api/forms error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/forms/:id — update form
forms.put('/api/forms/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{
      name?: string;
      description?: string | null;
      fields?: unknown[];
      onSubmitTagId?: string | null;
      onSubmitScenarioId?: string | null;
      saveToMetadata?: boolean;
      isActive?: boolean;
    }>();

    const updated = await updateForm(c.env.DB, id, {
      name: body.name,
      description: body.description,
      fields: body.fields !== undefined ? JSON.stringify(body.fields) : undefined,
      onSubmitTagId: body.onSubmitTagId,
      onSubmitScenarioId: body.onSubmitScenarioId,
      saveToMetadata: body.saveToMetadata,
      isActive: body.isActive,
    });

    if (!updated) {
      return c.json({ success: false, error: 'Form not found' }, 404);
    }

    return c.json({ success: true, data: serializeForm(updated) });
  } catch (err) {
    console.error('PUT /api/forms/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/forms/:id
forms.delete('/api/forms/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const form = await getFormById(c.env.DB, id);
    if (!form) {
      return c.json({ success: false, error: 'Form not found' }, 404);
    }
    await deleteForm(c.env.DB, id);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/forms/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/forms/:id/submissions — list submissions
forms.get('/api/forms/:id/submissions', async (c) => {
  try {
    const id = c.req.param('id');
    const form = await getFormById(c.env.DB, id);
    if (!form) {
      return c.json({ success: false, error: 'Form not found' }, 404);
    }
    const submissions = await getFormSubmissions(c.env.DB, id);
    return c.json({ success: true, data: submissions.map(serializeSubmission) });
  } catch (err) {
    console.error('GET /api/forms/:id/submissions error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/forms/:id/submit — submit form (public, used by LIFF)
forms.post('/api/forms/:id/submit', async (c) => {
  try {
    const formId = c.req.param('id');
    const form = await getFormById(c.env.DB, formId);
    if (!form) {
      return c.json({ success: false, error: 'Form not found' }, 404);
    }
    if (!form.is_active) {
      return c.json({ success: false, error: 'This form is no longer accepting responses' }, 400);
    }

    const body = await c.req.json<{
      idToken?: string;
      data?: Record<string, unknown>;
    }>();

    const submissionData = body.data ?? {};

    // Validate required fields
    const fields = JSON.parse(form.fields || '[]') as Array<{
      name: string;
      label: string;
      type: string;
      required?: boolean;
    }>;

    for (const field of fields) {
      if (field.required) {
        const val = submissionData[field.name];
        if (val === undefined || val === null || val === '') {
          return c.json(
            { success: false, error: `${field.label} は必須項目です` },
            400,
          );
        }
      }
    }

    // 友だち解決は LIFF ID トークンの検証済み sub のみ。ここは無認証の公開
    // エンドポイントなので、body 申告の friendId / lineUserId を信頼すると
    // 任意の友だちへの metadata 上書き・タグ/シナリオ付与・push 送信ができてしまう
    // （2026-09 監査）。トークン無し / 検証失敗でも提出は friend_id=null で保存する
    // （匿名送信の互換維持）が、下の副作用ブロックには入らない。
    let friendId: string | null = null;
    if (body.idToken) {
      const verified = await verifyLiffIdToken(c.env.DB, c.env, body.idToken);
      if (verified) {
        const friend = await getFriendByLineUserId(c.env.DB, verified.sub);
        if (friend) {
          friendId = friend.id;
        }
      }
    }

    // Save submission (friendId null if not resolved — avoids FK constraint)
    const submission = await createFormSubmission(c.env.DB, {
      formId,
      friendId: friendId || null,
      data: JSON.stringify(submissionData),
    });

    // Side effects (best-effort, don't fail the request)
    if (friendId) {
      const db = c.env.DB;
      const now = jstNow();

      const sideEffects: Promise<unknown>[] = [];

      // Save response data to friend's metadata
      if (form.save_to_metadata) {
        // 書いてよいのは form.fields に定義された name だけ（body.data の任意キー混入で
        // 連携キーが上書きされるのを防ぐ）。予約キーは field 名が衝突しても書かない。
        const allowedNames = new Set(fields.map((f) => f.name));
        const metadataSafe = Object.fromEntries(
          Object.entries(submissionData).filter(
            ([key]) => allowedNames.has(key) && !RESERVED_METADATA_KEYS.has(key),
          ),
        );
        sideEffects.push(
          (async () => {
            const friend = await getFriendById(db, friendId!);
            if (!friend) return;
            const existing = JSON.parse(friend.metadata || '{}') as Record<string, unknown>;
            const merged = { ...existing, ...metadataSafe };
            await db
              .prepare(`UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?`)
              .bind(JSON.stringify(merged), now, friendId)
              .run();
          })(),
        );
      }

      // Add tag
      if (form.on_submit_tag_id) {
        sideEffects.push(addTagToFriend(db, friendId, form.on_submit_tag_id));
      }

      // Enroll in scenario
      if (form.on_submit_scenario_id) {
        sideEffects.push(enrollFriendInScenario(db, friendId, form.on_submit_scenario_id));
      }

      // Send confirmation message with submitted data back to user
      sideEffects.push(
        (async () => {
          console.log('Form reply: starting for friendId', friendId);
          const friend = await getFriendById(db, friendId!);
          if (!friend?.line_user_id) { console.log('Form reply: no line_user_id'); return; }
          console.log('Form reply: sending to', friend.line_user_id);
          const { LineClient } = await import('@line-crm/line-sdk');
          // Resolve access token from friend's account (multi-account support)
          let accessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
          if ((friend as unknown as Record<string, unknown>).line_account_id) {
            const { getLineAccountById } = await import('@line-crm/db');
            const account = await getLineAccountById(db, (friend as unknown as Record<string, unknown>).line_account_id as string);
            if (account) accessToken = account.channel_access_token;
          }
          const lineClient = new LineClient(accessToken);

          // Build Flex card showing their answers
          const entries = Object.entries(submissionData as Record<string, unknown>);
          const answerRows = entries.map(([key, value]) => {
            const field = form.fields ? (JSON.parse(form.fields) as Array<{ name: string; label: string }>).find((f: { name: string }) => f.name === key) : null;
            const label = field?.label || key;
            const val = Array.isArray(value) ? value.join(', ') : (value !== null && value !== undefined && value !== '') ? String(value) : '-';
            return {
              type: 'box' as const, layout: 'vertical' as const, margin: 'md' as const,
              contents: [
                { type: 'text' as const, text: label, size: 'xxs' as const, color: '#64748b' },
                { type: 'text' as const, text: val, size: 'sm' as const, color: '#1e293b', weight: 'bold' as const, wrap: true },
              ],
            };
          });

          const flex = {
            type: 'bubble', size: 'giga',
            header: {
              type: 'box', layout: 'vertical',
              contents: [
                { type: 'text', text: '診断結果', size: 'lg', weight: 'bold', color: '#1e293b' },
                { type: 'text', text: `${friend.display_name || ''}さんのプロフィール`, size: 'xs', color: '#64748b', margin: 'sm' },
              ],
              paddingAll: '20px', backgroundColor: '#f0fdf4',
            },
            body: {
              type: 'box', layout: 'vertical',
              contents: [
                ...answerRows,
                { type: 'separator', margin: 'lg' },
                ...(form.save_to_metadata ? [{ type: 'box', layout: 'vertical', margin: 'lg', backgroundColor: '#eff6ff', cornerRadius: 'md', paddingAll: '12px',
                  contents: [
                    { type: 'text', text: 'メタデータに自動保存済み。今後の配信があなたに最適化されます。', size: 'xxs', color: '#2563EB', wrap: true },
                  ],
                }] : []),
              ],
              paddingAll: '20px',
            },
            footer: {
              type: 'box', layout: 'vertical', paddingAll: '16px',
              contents: [
                { type: 'button', action: { type: 'message', label: 'アカウント連携を見る', text: 'アカウント連携を見る' }, style: 'primary', color: '#14b8a6' },
              ],
            },
          };

          const { buildMessage } = await import('../services/step-delivery.js');
          // 未フォロー（友だち未追加/ブロック中）には届かない。送信失敗として記録してスキップ。
          if (!friend.is_following) {
            const { logFailedOutgoing } = await import('../services/message-log.boxiv.js');
            await logFailedOutgoing(db, friend.id, 'flex', JSON.stringify(flex));
            console.log('Form reply: friend not following — skip push, recorded as failed');
            return;
          }
          await lineClient.pushMessage(friend.line_user_id, [buildMessage('flex', JSON.stringify(flex))]);
        })(),
      );

      if (sideEffects.length > 0) {
        const results = await Promise.allSettled(sideEffects);
        for (const r of results) {
          if (r.status === 'rejected') console.error('Form side-effect failed:', r.reason);
        }
      }
    }

    return c.json({ success: true, data: serializeSubmission(submission) }, 201);
  } catch (err) {
    console.error('POST /api/forms/:id/submit error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { forms };
