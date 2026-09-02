import type { HttpClient } from '../http.js'
import type { ApiResponse } from '../types.js'

/**
 * 送信相手ごとの下書き（BOXIV / message_drafts）。
 *
 * あらかじめ用意しておいた文面を友だちに紐付けて保存する箱で、**自動送信はされない**。
 * オペレーターが管理画面のチャット入力欄の ✏️ から挿入し、内容を見てから送る。
 */
export interface MessageDraft {
  id: string
  friendId: string
  /** 一覧で見分ける見出し（任意） */
  title: string | null
  content: string
  /**
   * 'admin' = 管理画面のオペレーター / 'api' = MCP・API 経由（既定）。
   * 呼び出し側の申告で決まる表示ラベル。誰が置いたかは createdBy* を見ること。
   */
  createdVia: 'admin' | 'api'
  createdById: string | null
  createdByName: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateDraftInput {
  content: string
  title?: string | null
}

export interface UpdateDraftInput {
  content?: string
  title?: string | null
}

export class DraftsResource {
  constructor(private readonly http: HttpClient) {}

  async list(friendId: string): Promise<MessageDraft[]> {
    const res = await this.http.get<ApiResponse<MessageDraft[]>>(`/api/friends/${friendId}/drafts`)
    return res.data
  }

  async create(friendId: string, input: CreateDraftInput): Promise<MessageDraft> {
    const res = await this.http.post<ApiResponse<MessageDraft>>(`/api/friends/${friendId}/drafts`, input)
    return res.data
  }

  async update(id: string, input: UpdateDraftInput): Promise<MessageDraft> {
    const res = await this.http.put<ApiResponse<MessageDraft>>(`/api/drafts/${id}`, input)
    return res.data
  }

  async delete(id: string): Promise<void> {
    await this.http.delete(`/api/drafts/${id}`)
  }
}
