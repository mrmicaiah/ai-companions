// ============================================================
// CHARACTER AGENT (Durable Object)
// Handles conversation state, memory, and AI responses
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, CHARACTER_INFO, getContextualPrompt } from './personality';

interface Env {
  MEMORY: R2Bucket;
  ANTHROPIC_API_KEY: string;
  SENDBLUE_API_KEY: string;
  SENDBLUE_API_SECRET: string;
  USER_PHONE: string;
  CHARACTER_PHONE: string;
}

interface HotMemory {
  recent_messages: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
  }>;
  current_session_id: string | null;
  session_start: string | null;
  last_message_at: string | null;
}

interface Session {
  id: string;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
  message_count: number;
  topics: string[];
}

// Export class name matches {{CHARACTER_CLASS}} placeholder
export class {{CHARACTER_CLASS}} {
  private state: DurableObjectState;
  private env: Env;
  private sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    
    // Initialize tables
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );
      
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        summary TEXT,
        message_count INTEGER DEFAULT 0,
        topics TEXT DEFAULT '[]'
      );
      
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    try {
      // Handle incoming message
      if (url.pathname === '/message' && request.method === 'POST') {
        const { content } = await request.json() as { content: string };
        await this.handleMessage(content);
        return new Response('OK');
      }
      
      // Proactive gap check
      if (url.pathname === '/rhythm/checkGap') {
        await this.checkAndReachOut();
        return new Response('OK');
      }
      
      // Cleanup old data
      if (url.pathname === '/rhythm/cleanup') {
        await this.cleanup();
        return new Response('OK');
      }
      
      // Debug: get hot memory
      if (url.pathname === '/debug/hot') {
        const hot = await this.getHotMemory();
        return new Response(JSON.stringify(hot, null, 2), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Debug: get recent sessions
      if (url.pathname === '/debug/sessions') {
        const sessions = this.sql.exec(`
          SELECT * FROM sessions ORDER BY started_at DESC LIMIT 10
        `).toArray();
        return new Response(JSON.stringify(sessions, null, 2), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Debug: get message count
      if (url.pathname === '/debug/stats') {
        const count = this.sql.exec(`SELECT COUNT(*) as count FROM messages`).one();
        const sessionCount = this.sql.exec(`SELECT COUNT(*) as count FROM sessions`).one();
        return new Response(JSON.stringify({
          messages: count?.count || 0,
          sessions: sessionCount?.count || 0
        }, null, 2), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      return new Response('Not found', { status: 404 });
    } catch (error) {
      console.error('Agent error:', error);
      return new Response(JSON.stringify({ error: String(error) }), { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  private async handleMessage(content: string): Promise<void> {
    const now = new Date();
    const hot = await this.getHotMemory();
    
    // Check if we need a new session (>2 hours gap)
    const needsNewSession = !hot.last_message_at || 
      (now.getTime() - new Date(hot.last_message_at).getTime() > 2 * 60 * 60 * 1000);
    
    if (needsNewSession) {
      // Close previous session if exists
      if (hot.current_session_id) {
        await this.closeSession(hot.current_session_id);
      }
      
      // Start new session
      const sessionId = `session_${Date.now()}`;
      this.sql.exec(`
        INSERT INTO sessions (id, started_at, message_count)
        VALUES (?, ?, 0)
      `, sessionId, now.toISOString());
      
      hot.current_session_id = sessionId;
      hot.session_start = now.toISOString();
      hot.recent_messages = [];
    }
    
    // Store user message
    this.sql.exec(`
      INSERT INTO messages (session_id, role, content, timestamp)
      VALUES (?, 'user', ?, ?)
    `, hot.current_session_id, content, now.toISOString());
    
    // Add to hot memory
    hot.recent_messages.push({
      role: 'user',
      content,
      timestamp: now.toISOString()
    });
    
    // Trim hot memory to last 20 messages
    if (hot.recent_messages.length > 20) {
      hot.recent_messages = hot.recent_messages.slice(-20);
    }
    
    hot.last_message_at = now.toISOString();
    
    // Update session message count
    this.sql.exec(`
      UPDATE sessions SET message_count = message_count + 1 WHERE id = ?
    `, hot.current_session_id);
    
    // Generate response
    const response = await this.generateResponse(hot);
    
    // Store assistant message
    this.sql.exec(`
      INSERT INTO messages (session_id, role, content, timestamp)
      VALUES (?, 'assistant', ?, ?)
    `, hot.current_session_id, response, new Date().toISOString());
    
    hot.recent_messages.push({
      role: 'assistant',
      content: response,
      timestamp: new Date().toISOString()
    });
    
    // Update hot memory
    await this.saveHotMemory(hot);
    
    // Update session message count
    this.sql.exec(`
      UPDATE sessions SET message_count = message_count + 1 WHERE id = ?
    `, hot.current_session_id);
    
    // Send response via SendBlue
    await this.sendMessage(response);
  }

  private async generateResponse(hot: HotMemory): Promise<string> {
    const anthropic = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
    
    // Build context
    const previousSessions = this.sql.exec(`
      SELECT * FROM sessions 
      WHERE id != ? AND summary IS NOT NULL
      ORDER BY started_at DESC LIMIT 5
    `, hot.current_session_id || '').toArray() as Session[];
    
    const sessionList = previousSessions.map(s => 
      `- ${s.started_at}: ${s.summary}`
    ).join('\n');
    
    const contextPrompt = getContextualPrompt({
      currentTime: new Date(),
      isNewSession: hot.recent_messages.length <= 2,
      previousSessionSummary: previousSessions[0]?.summary || undefined,
      sessionList: sessionList || undefined
    });
    
    const systemPrompt = SYSTEM_PROMPT + contextPrompt;
    
    // Build messages
    const messages = hot.recent_messages.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content
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

  private async sendMessage(content: string): Promise<void> {
    const response = await fetch('https://api.sendblue.co/api/send-message', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'sb-api-key-id': this.env.SENDBLUE_API_KEY,
        'sb-api-secret-key': this.env.SENDBLUE_API_SECRET
      },
      body: JSON.stringify({
        number: this.env.USER_PHONE,
        content,
        from_number: this.env.CHARACTER_PHONE
      })
    });
    
    if (!response.ok) {
      console.error('SendBlue error:', await response.text());
    }
  }

  private async checkAndReachOut(): Promise<void> {
    const hot = await this.getHotMemory();
    
    if (!hot.last_message_at) return;
    
    const hoursSinceLastMessage = 
      (Date.now() - new Date(hot.last_message_at).getTime()) / (1000 * 60 * 60);
    
    // Reach out if 24-48 hours have passed
    if (hoursSinceLastMessage >= 24 && hoursSinceLastMessage < 48) {
      // Generate proactive message based on last conversation
      const anthropic = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
      
      const lastSession = this.sql.exec(`
        SELECT * FROM sessions WHERE summary IS NOT NULL
        ORDER BY started_at DESC LIMIT 1
      `).one() as Session | null;
      
      const prompt = lastSession?.summary 
        ? `Based on your last conversation about: "${lastSession.summary}", send a brief, natural check-in message.`
        : `Send a brief, natural check-in message to see how they're doing.`;
      
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 200,
        system: SYSTEM_PROMPT + `\n\n${prompt}`,
        messages: [{ role: 'user', content: '[SYSTEM: Generate proactive outreach]' }]
      });
      
      const textBlock = response.content.find(b => b.type === 'text');
      if (textBlock?.text) {
        await this.sendMessage(textBlock.text);
        
        // Mark that we reached out
        hot.last_message_at = new Date().toISOString();
        await this.saveHotMemory(hot);
      }
    }
  }

  private async closeSession(sessionId: string): Promise<void> {
    // Get session messages
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
    
    // Generate summary
    const anthropic = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
    
    const conversationText = messages.map(m => 
      `${m.role}: ${m.content}`
    ).join('\n');
    
    const summaryResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: `Summarize this conversation in 1-2 sentences, focusing on what was discussed and any important details:\n\n${conversationText}`
      }]
    });
    
    const summary = summaryResponse.content.find(b => b.type === 'text')?.text || null;
    
    this.sql.exec(`
      UPDATE sessions SET ended_at = ?, summary = ? WHERE id = ?
    `, new Date().toISOString(), summary, sessionId);
  }

  private async cleanup(): Promise<void> {
    // Archive old messages (keep last 30 days in SQLite)
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    
    // Get old sessions to archive to R2
    const oldSessions = this.sql.exec(`
      SELECT * FROM sessions WHERE ended_at < ?
    `, cutoff).toArray();
    
    if (oldSessions.length > 0) {
      // Archive to R2
      const archiveKey = `archives/${new Date().toISOString().split('T')[0]}.json`;
      await this.env.MEMORY.put(archiveKey, JSON.stringify(oldSessions));
      
      // Delete from SQLite
      for (const session of oldSessions) {
        this.sql.exec(`DELETE FROM messages WHERE session_id = ?`, session.id);
        this.sql.exec(`DELETE FROM sessions WHERE id = ?`, session.id);
      }
    }
  }

  private async getHotMemory(): Promise<HotMemory> {
    const obj = await this.env.MEMORY.get('hot-memory.json');
    if (!obj) {
      return {
        recent_messages: [],
        current_session_id: null,
        session_start: null,
        last_message_at: null
      };
    }
    return JSON.parse(await obj.text());
  }

  private async saveHotMemory(hot: HotMemory): Promise<void> {
    await this.env.MEMORY.put('hot-memory.json', JSON.stringify(hot));
  }
}
