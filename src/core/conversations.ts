import type { AppData, Conversation, Message } from "./schema";

const TITLE_LENGTH = 48;

export function newId(): string {
  return crypto.randomUUID();
}

export function titleFrom(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : line || "Nieuwe chat";
}

export function sortedConversations(data: AppData): Conversation[] {
  return [...data.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Adds a user message to an existing conversation, or creates one; returns the conversation id. */
export function addUserMessage(draft: AppData, conversationId: string | null, text: string): string {
  const now = new Date().toISOString();
  const message: Message = { id: newId(), role: "user", content: text, createdAt: now };
  const existing = conversationId ? draft.conversations.find((c) => c.id === conversationId) : undefined;
  if (existing) {
    existing.messages.push(message);
    existing.updatedAt = now;
    return existing.id;
  }
  const conversation: Conversation = {
    id: newId(),
    title: titleFrom(text),
    createdAt: now,
    updatedAt: now,
    messages: [message],
  };
  draft.conversations.push(conversation);
  return conversation.id;
}

export function renameConversation(draft: AppData, id: string, title: string): void {
  const conversation = draft.conversations.find((c) => c.id === id);
  if (conversation) conversation.title = title.trim() || conversation.title;
}

export function deleteConversation(draft: AppData, id: string): void {
  draft.conversations = draft.conversations.filter((c) => c.id !== id);
}
