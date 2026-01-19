// ============================================================
// CHARACTER WORKER - MULTI-USER TELEGRAM VERSION
// One bot, thousands of users
// ============================================================

import { {{CHARACTER_CLASS}} } from './agent';

export { {{CHARACTER_CLASS}} };

const VERSION = {
  version: '1.0.0',
  character: '{{CHARACTER_NAME}}',
  display_name: '{{DISPLAY_NAME}}'
};

interface Env {
  MEMORY: R2Bucket;
  CHARACTER: DurableObjectNamespace;
  ANTHROPIC_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: {
      id: number;
      first_name: string;
      last_name?: string;
      username?: string;
    };
    chat: {
      id: number;
      type: string;
    };
    date: number;
    text?: string;
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    
    // Singleton Durable Object (handles all users)
    const id = env.CHARACTER.idFromName('{{CHARACTER_NAME}}-v1');
    const character = env.CHARACTER.get(id);

    // Health/version
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', ...VERSION }, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/version') {
      return new Response(`${VERSION.display_name} v${VERSION.version}`);
    }

    // Telegram webhook - handles ALL users
    if (url.pathname === '/telegram' && request.method === 'POST') {
      const update = await request.json() as TelegramUpdate;
      
      // Only process text messages
      if (!update.message?.text) {
        return new Response('OK');
      }
      
      const chatId = update.message.chat.id.toString();
      const content = update.message.text;
      const user = update.message.from;

      // Send "typing" indicator
      ctx.waitUntil(
        fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendChatAction`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            action: 'typing'
          })
        })
      );

      // Forward to Durable Object with user info
      ctx.waitUntil(
        character.fetch(new Request('https://internal/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            content, 
            chatId,
            user: {
              id: user.id,
              firstName: user.first_name,
              lastName: user.last_name,
              username: user.username
            }
          })
        }))
      );

      return new Response('OK');
    }

    // Setup webhook helper
    if (url.pathname === '/setup-webhook' && request.method === 'POST') {
      const webhookUrl = `${url.origin}/telegram`;
      const response = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: webhookUrl })
        }
      );
      const result = await response.json();
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get webhook info
    if (url.pathname === '/webhook-info') {
      const response = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`
      );
      const result = await response.json();
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Admin/debug endpoints - forward to Durable Object
    if (url.pathname.startsWith('/debug/') || url.pathname.startsWith('/admin/')) {
      return character.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const id = env.CHARACTER.idFromName('{{CHARACTER_NAME}}-v1');
    const character = env.CHARACTER.get(id);

    // Timezone handling
    const now = new Date();
    const utcHour = now.getUTCHours();
    const TIMEZONE_OFFSET = {{TIMEZONE_OFFSET}}; // e.g., 5 for EST
    const localHour = (utcHour - TIMEZONE_OFFSET + 24) % 24;

    // Proactive outreach check during active hours
    if (localHour >= {{OUTREACH_START}} && localHour <= {{OUTREACH_END}}) {
      ctx.waitUntil(
        character.fetch(new Request('https://internal/rhythm/checkAllUsers'))
      );
    }

    // Cleanup at 3am local
    if (localHour === 3) {
      ctx.waitUntil(
        character.fetch(new Request('https://internal/rhythm/cleanup'))
      );
    }
  }
};
