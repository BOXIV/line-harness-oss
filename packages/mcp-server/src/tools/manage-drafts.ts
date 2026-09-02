import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getClient } from "../client.js";

/**
 * 送信相手ごとの下書き（BOXIV / message_drafts）。
 *
 * ここで作った文面は **自動では送られない**。管理画面のチャット入力欄の ✏️ に溜まり、
 * オペレーターが内容を見てから送る。「返信案を用意しておく」用途のための口で、
 * 実送信が要るときは send_message を使う。
 */
export function registerManageDrafts(server: McpServer): void {
  server.tool(
    "manage_drafts",
    "送信相手（友だち）ごとの下書きの管理。list: 一覧、create: 作成、update: 更新、delete: 削除。作った下書きは自動送信されず、オペレーターが管理画面で確認してから送る（すぐ送りたい場合は send_message を使う）。",
    {
      action: z.enum(["list", "create", "update", "delete"]).describe("Action to perform"),
      friendId: z.string().optional().describe("Friend ID (required for list, create)"),
      draftId: z.string().optional().describe("Draft ID (required for update, delete)"),
      content: z.string().optional().describe("Draft body text (required for create; optional for update). Max 5000 chars"),
      title: z.string().nullable().optional().describe("Short heading shown in the draft list (optional)"),
    },
    async ({ action, friendId, draftId, content, title }) => {
      try {
        const client = getClient();

        if (action === "list") {
          if (!friendId) throw new Error("friendId is required for list");
          const drafts = await client.drafts.list(friendId);
          return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, drafts }, null, 2) }] };
        }

        if (action === "create") {
          if (!friendId) throw new Error("friendId is required for create");
          if (!content) throw new Error("content is required for create");
          const draft = await client.drafts.create(friendId, { content, title: title ?? null });
          return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, draft }, null, 2) }] };
        }

        if (!draftId) throw new Error("draftId is required for this action");

        if (action === "update") {
          const input: { content?: string; title?: string | null } = {};
          if (content !== undefined) input.content = content;
          if (title !== undefined) input.title = title;
          if (Object.keys(input).length === 0) throw new Error("content or title is required for update");
          const draft = await client.drafts.update(draftId, input);
          return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, draft }, null, 2) }] };
        }

        await client.drafts.delete(draftId);
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, deleted: draftId }, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: message }, null, 2) }],
          isError: true,
        };
      }
    },
  );
}
