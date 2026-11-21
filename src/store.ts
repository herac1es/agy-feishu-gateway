import fs from 'node:fs';
import path from 'node:path';

export interface ConversationSessionRecord {
  conversationKey: string;
  sessionId?: string;
  cwd: string;
  modelId?: string;
  thoughtLevel?: string;
  updatedAt: string;
}

export class SessionStore {
  private readonly filePath: string;
  private records = new Map<string, ConversationSessionRecord>();

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'sessions.json');
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) {
      return;
    }
    const raw = fs.readFileSync(this.filePath, 'utf8').trim();
    if (!raw) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`会话索引文件损坏 (${this.filePath}): ${msg}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return;
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue;
      const item = value as Partial<ConversationSessionRecord>;
      if (typeof item.cwd === 'string' && item.cwd) {
        this.records.set(key, {
          conversationKey: key,
          sessionId: typeof item.sessionId === 'string' && item.sessionId ? item.sessionId : undefined,
          cwd: item.cwd,
          modelId: typeof item.modelId === 'string' && item.modelId ? item.modelId : undefined,
          thoughtLevel:
            typeof item.thoughtLevel === 'string' && item.thoughtLevel ? item.thoughtLevel : undefined,
          updatedAt:
            typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
        });
      }
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const obj: Record<string, ConversationSessionRecord> = {};
    for (const [key, record] of this.records.entries()) {
      obj[key] = record;
    }
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmpPath, this.filePath);
  }

  get(conversationKey: string): ConversationSessionRecord | undefined {
    return this.records.get(conversationKey);
  }

  set(record: ConversationSessionRecord): void {
    this.records.set(record.conversationKey, record);
    this.save();
  }

  delete(conversationKey: string): boolean {
    const removed = this.records.delete(conversationKey);
    if (removed) {
      this.save();
    }
    return removed;
  }

  list(): ConversationSessionRecord[] {
    return Array.from(this.records.values());
  }
}

export class MessageDeduper {
  private readonly maxEntries: number;
  private readonly seen = new Set<string>();

  constructor(maxEntries = 2000) {
    this.maxEntries = Math.max(10, maxEntries);
  }

  /**
   * Returns true if the key has NOT been seen before (and marks it as seen).
   */
  markIfNew(key: string): boolean {
    if (!key) {
      return true;
    }
    if (this.seen.has(key)) {
      return false;
    }
    this.seen.add(key);
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.values().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return true;
  }
}
