// ============================================================
// CHARACTER AGENT - MULTI-USER VERSION
// Handles thousands of users, each with their own memory
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, CHARACTER_INFO, getContextualPrompt, getWelcomePrompt } from './personality';

interface Env {
  MEMORY: R2Bucket;
  ANTHROPIC_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
}

// User lifecycle statuses
type UserStatus = 'new' | 'trial' | 'hooked' | 'active' | 'paused' | 'churned';

interface User {
  chat_id: string;
  telegram_id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  status: UserStatus;
  message_count: number;
  trial_messages_remaining: number;
  created_at: string;
  last_message_at: string;
  last_outreach_at?: string;
  timezone_offset?: number;
  ref_code?: string;
}

interface Session {
  id: string;
  chat_id: string;
  started_at: string;
  ended_at?: string;
  summary?: string;
  message_count: number;
}

const TRIAL_MESSAGE_LIMIT = 25;

export class {{CHARACTER_CLASS}} {
  private state: DurableObjectState;
  private env: Env;
  private sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    
    this.initDatabase();
  }

  private initDatabase() {
    this.sql.exec(`
      -- Users table
      CREATE TABLE IF NOT EXISTS users (
        chat_id TEXT PRIMARY KEY,
        telegram_id INTEGER,
        first_name TEXT,
        last_name TEXT,
        username TEXT,
        status TEXT DEFAULT 'new',
        message_count INTEGER DEFAULT 0,
        trial_messages_remaining INTEGER DEFAULT ${TRIAL_MESSAGE_LIMIT},
        created_at TEXT,
        last_message_at TEXT,
        last_outreach_at TEXT,
        timezone_offset INTEGER,
        ref_code TEXT
      );
      
      -- Messages table (per user)
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );
      
      -- Sessions table (per user)
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        summary TEXT,
        message_count INTEGER DEFAULT 0
      );
      
      CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_chat ON sessions(chat_id);
      CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
      CREATE INDEX IF NOT EXISTS idx_users_last_message ON users(last_message_at);
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    try {
      // Incoming message from user
      if (url.pathname === '/message' && request.method === 'POST') {
        const data = await request.json() as {
          content: string;
          chatId: string;
          user: { id: number; firstName: string; lastName?: string; username?: string };
          refCode?: string;
          isNewUser?: boolean;
        };
        await this.handleMessage(data);
        return new Response('OK');
      }
      
      // Proactive outreach to all eligible users
      if (url.pathname === '/rhythm/checkAllUsers') {
        await this.checkAllUsersForOutreach();
        return new Response('OK');
      }
      
      // Cleanup
      if (url.pathname === '/rhythm/cleanup') {
        await this.cleanup();
        return new Response('OK');
      }
      
      // === Admin/Debug Endpoints ===
      
      if (url.pathname === '/admin/users') {
        const users = this.sql.exec(`
          SELECT * FROM users ORDER BY last_message_at DESC LIMIT 100
        `).toArray();
        return this.jsonResponse({ users, count: users.length });
      }
      
      if (url.pathname.startsWith('/admin/users/')) {
        const chatId = url.pathname.split('/').pop();
        const user = this.sql.exec(`SELECT * FROM users WHERE chat_id = ?`, chatId).one();
        if (!user) return this.jsonResponse({ error: 'User not found' }, 404);
        
        const sessions = this.sql.exec(`
          SELECT * FROM sessions WHERE chat_id = ? ORDER BY started_at DESC LIMIT 10
        `, chatId).toArray();
        
        const recentMessages = this.sql.exec(`
          SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT 20
        `, chatId).toArray();
        
        return this.jsonResponse({ user, sessions, recentMessages });
      }
      
      if (url.pathname === '/debug/stats') {
        const userCount = this.sql.exec(`SELECT COUNT(*) as count FROM users`).one();
        const messageCount = this.sql.exec(`SELECT COUNT(*) as count FROM messages`).one();
        const sessionCount = this.sql.exec(`SELECT COUNT(*) as count FROM sessions`).one();
        const statusBreakdown = this.sql.exec(`
          SELECT status, COUNT(*) as count FROM users GROUP BY status
        `).toArray();
        
        return this.jsonResponse({
          users: userCount?.count || 0,
          messages: messageCount?.count || 0,
          sessions: sessionCount?.count || 0,
          byStatus: statusBreakdown
        });
      }
      
      return new Response('Not found', { status: 404 });
    } catch (error) {
      console.error('Agent error:', error);
      return this.jsonResponse({ error: String(error) }, 500);
    }
  }

  private async handleMessage(data: {
    content: string;
    chatId: string;
    user: { id: number; firstName: string; lastName?: string; username?: string };
    refCode?: string;
    isNewUser?: boolean;
  }): Promise<void> {
    const { content, chatId, user: telegramUser, refCode, isNewUser } = data;
    const now = new Date();
    
    // Get or create user
    let user = this.sql.exec(`SELECT * FROM users WHERE chat_id = ?`, chatId).one() as User | null;
    const isFirstTimeUser = !user;
    
    if (!user) {
      // New user from website
      this.sql.exec(`
        INSERT INTO users (chat_id, telegram_id, first_name, last_name, username, status, created_at, last_message_at, trial_messages_remaining, ref_code)
        VALUES (?, ?, ?, ?, ?, 'trial', ?, ?, ?, ?)
      `, chatId, telegramUser.id, telegramUser.firstName, telegramUser.lastName || null, 
         telegramUser.username || null, now.toISOString(), now.toISOString(), TRIAL_MESSAGE_LIMIT, refCode || null);
      
      user = this.sql.exec(`SELECT * FROM users WHERE chat_id = ?`, chatId).one() as User;
    }
    
    // Handle /start command - send welcome message
    if (content === '__START__') {
      await this.sendWelcomeMessage(user, isFirstTimeUser);
      return;
    }
    
    // Check trial status
    if (user.status === 'trial' && user.trial_messages_remaining <= 0) {
      await this.sendMessage(chatId, 
        `Hey ${user.first_name}! You've used all your free messages. To keep chatting, upgrade to unlimited access! 💬\n\n[Link to upgrade coming soon]`
      );
      return;
    }
    
    // Get or create session
    const lastSession = this.sql.exec(`
      SELECT * FROM sessions WHERE chat_id = ? ORDER BY started_at DESC LIMIT 1
    `, chatId).one() as Session | null;
    
    const needsNewSession = !lastSession || 
      (now.getTime() - new Date(lastSession.started_at).getTime() > 2 * 60 * 60 * 1000);
    
    let sessionId: string;
    
    if (needsNewSession) {
      if (lastSession && !lastSession.ended_at) {
        await this.closeSession(lastSession.id, chatId);
      }
      
      sessionId = `${chatId}_${Date.now()}`;
      this.sql.exec(`
        INSERT INTO sessions (id, chat_id, started_at, message_count)
        VALUES (?, ?, ?, 0)
      `, sessionId, chatId, now.toISOString());
    } else {
      sessionId = lastSession!.id;
    }
    
    // Store user message
    this.sql.exec(`
      INSERT INTO messages (chat_id, session_id, role, content, timestamp)
      VALUES (?, ?, 'user', ?, ?)
    `, chatId, sessionId, content, now.toISOString());
    
    // Update counts
    this.sql.exec(`UPDATE sessions SET message_count = message_count + 1 WHERE id = ?`, sessionId);
    this.sql.exec(`
      UPDATE users SET 
        message_count = message_count + 1,
        trial_messages_remaining = trial_messages_remaining - 1,
        last_message_at = ?
      WHERE chat_id = ?
    `, now.toISOString(), chatId);
    
    // Generate response
    const response = await this.generateResponse(chatId, sessionId, user);
    
    // Store assistant message
    this.sql.exec(`
      INSERT INTO messages (chat_id, session_id, role, content, timestamp)
      VALUES (?, ?, 'assistant', ?, ?)
    `, chatId, sessionId, response, new Date().toISOString());
    
    this.sql.exec(`UPDATE sessions SET message_count = message_count + 1 WHERE id = ?`, sessionId);
    
    // Send response
    await this.sendMessage(chatId, response);
    
    // Update user status if needed
    this.updateUserStatus(chatId);
  }

  private async sendWelcomeMessage(user: User, isFirstTime: boolean): Promise<void> {
    const anthropic = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
    
    const welcomePrompt = getWelcomePrompt(user.first_name, isFirstTime);
    
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: SYSTEM_PROMPT + `\n\n${welcomePrompt}`,
      messages: [{ role: 'user', content: '[SYSTEM: User just clicked to chat from the website. Send your opening message.]' }]
    });
    
    const textBlock = response.content.find(b => b.type === 'text');
    if (textBlock?.text) {
      await this.sendMessage(user.chat_id, textBlock.text);
    }
  }

  private async generateResponse(chatId: string, sessionId: string, user: User): Promise<string> {
    const anthropic = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
    
    const recentMessages = this.sql.exec(`
      SELECT role, content FROM messages 
      WHERE chat_id = ? 
      ORDER BY timestamp DESC LIMIT 20
    `, chatId).toArray().reverse();
    
    const previousSessions = this.sql.exec(`
      SELECT * FROM sessions 
      WHERE chat_id = ? AND id != ? AND summary IS NOT NULL
      ORDER BY started_at DESC LIMIT 5
    `, chatId, sessionId).toArray() as Session[];
    
    const sessionList = previousSessions.map(s => 
      `- ${s.started_at}: ${s.summary}`
    ).join('\n');
    
    const contextPrompt = getContextualPrompt({
      currentTime: new Date(),
      isNewSession: recentMessages.length <= 2,
      previousSessionSummary: previousSessions[0]?.summary,
      sessionList: sessionList || undefined
    });
    
    const userContext = `\n## USER INFO\nName: ${user.first_name}${user.last_name ? ' ' + user.last_name : ''}\nMessages exchanged: ${user.message_count}\n`;
    
    const systemPrompt = SYSTEM_PROMPT + userContext + contextPrompt;
    
    const messages = recentMessages.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content as string
    }));
    
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: systemPrompt,
      messages
    });
    
    const textBlock = response.content.find(b => b.type === 'text');
    return textBlock?.text || "...";
  }

  private async sendMessage(chatId: string, content: string): Promise<void> {
    const response = await fetch(
      `https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: content
        })
      }
    );
    
    if (!response.ok) {
      console.error('Telegram error:', await response.text());
    }
  }

  private updateUserStatus(chatId: string): void {
    const user = this.sql.exec(`SELECT * FROM users WHERE chat_id = ?`, chatId).one() as User;
    if (!user) return;
    
    let newStatus = user.status;
    
    if (user.status === 'trial' && user.message_count >= 10) {
      newStatus = 'hooked';
    }
    
    if (newStatus !== user.status) {
      this.sql.exec(`UPDATE users SET status = ? WHERE chat_id = ?`, newStatus, chatId);
    }
  }

  private async closeSession(sessionId: string, chatId: string): Promise<void> {
    const messages = this.sql.exec(`
      SELECT role, content FROM messages 
      WHERE session_id = ? 
      ORDER BY timestamp
    `, sessionId).toArray();
    
    if (messages.length < 2) {
      this.sql.exec(`UPDATE sessions SET ended_at = ? WHERE id = ?`, 
        new Date().toISOString(), sessionId);
      return;
    }
    
    const anthropic = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
    
    const conversationText = messages.map(m => 
      `${m.role}: ${m.content}`
    ).join('\n');
    
    const summaryResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: `Summarize this conversation in 1-2 sentences:\n\n${conversationText}`
      }]
    });
    
    const summary = summaryResponse.content.find(b => b.type === 'text')?.text || null;
    
    this.sql.exec(`
      UPDATE sessions SET ended_at = ?, summary = ? WHERE id = ?
    `, new Date().toISOString(), summary, sessionId);
  }

  private async checkAllUsersForOutreach(): Promise<void> {
    const cutoffStart = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const cutoffEnd = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    
    const eligibleUsers = this.sql.exec(`
      SELECT * FROM users 
      WHERE status IN ('trial', 'hooked', 'active')
      AND last_message_at < ?
      AND last_message_at > ?
      AND (last_outreach_at IS NULL OR last_outreach_at < last_message_at)
      LIMIT 10
    `, cutoffEnd, cutoffStart).toArray() as User[];
    
    for (const user of eligibleUsers) {
      await this.sendProactiveMessage(user);
    }
  }

  private async sendProactiveMessage(user: User): Promise<void> {
    const lastSession = this.sql.exec(`
      SELECT * FROM sessions WHERE chat_id = ? AND summary IS NOT NULL
      ORDER BY started_at DESC LIMIT 1
    `, user.chat_id).one() as Session | null;
    
    const anthropic = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
    
    const prompt = lastSession?.summary 
      ? `Based on your last conversation about: "${lastSession.summary}", send a brief, natural check-in to ${user.first_name}.`
      : `Send a brief, natural check-in message to ${user.first_name}.`;
    
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      system: SYSTEM_PROMPT + `\n\n${prompt}`,
      messages: [{ role: 'user', content: '[SYSTEM: Generate proactive outreach]' }]
    });
    
    const textBlock = response.content.find(b => b.type === 'text');
    if (textBlock?.text) {
      await this.sendMessage(user.chat_id, textBlock.text);
      
      this.sql.exec(`
        UPDATE users SET last_outreach_at = ? WHERE chat_id = ?
      `, new Date().toISOString(), user.chat_id);
    }
  }

  private async cleanup(): Promise<void> {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    
    const oldSessions = this.sql.exec(`
      SELECT * FROM sessions WHERE ended_at < ?
    `, cutoff).toArray();
    
    if (oldSessions.length > 0) {
      const archiveKey = `archives/sessions_${new Date().toISOString().split('T')[0]}.json`;
      await this.env.MEMORY.put(archiveKey, JSON.stringify(oldSessions));
      
      for (const session of oldSessions) {
        this.sql.exec(`DELETE FROM messages WHERE session_id = ?`, session.id);
        this.sql.exec(`DELETE FROM sessions WHERE id = ?`, session.id);
      }
    }
    
    const pauseCutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    this.sql.exec(`
      UPDATE users SET status = 'paused' 
      WHERE status IN ('trial', 'hooked', 'active') 
      AND last_message_at < ?
    `, pauseCutoff);
    
    this.sql.exec(`
      UPDATE users SET status = 'churned' 
      WHERE status = 'paused' 
      AND last_message_at < ?
    `, cutoff);
  }

  private jsonResponse(data: any, status = 200): Response {
    return new Response(JSON.stringify(data, null, 2), {
      status,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
