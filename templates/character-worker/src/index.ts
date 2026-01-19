// ============================================================
// CHARACTER WORKER TEMPLATE
// Replace all {{PLACEHOLDER}} values during character creation
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
  SENDBLUE_API_KEY: string;
  SENDBLUE_API_SECRET: string;
  USER_PHONE: string;
  CHARACTER_PHONE: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    
    // Singleton Durable Object
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

    // SendBlue webhook
    if (url.pathname === '/imessage' && request.method === 'POST') {
      const data = await request.json() as any;
      const from = data.from_number || data.number;
      const content = data.content || data.message || data.text;

      if (from !== env.USER_PHONE) {
        console.log('Ignoring message from:', from);
        return new Response('OK');
      }

      ctx.waitUntil(
        character.fetch(new Request('https://internal/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content })
        }))
      );

      return new Response('OK');
    }

    // WhatsApp webhook (if using)
    if (url.pathname === '/whatsapp' && request.method === 'POST') {
      // Similar handling for WhatsApp
      return new Response('OK');
    }

    // Debug endpoints - forward to Durable Object
    if (url.pathname.startsWith('/debug/')) {
      return character.fetch(new Request(`https://internal${url.pathname}`));
    }

    // Memory endpoints
    if (url.pathname.startsWith('/memory/')) {
      return character.fetch(new Request(`https://internal${url.pathname}`));
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

    // Proactive check during active hours
    if (localHour >= {{OUTREACH_START}} && localHour <= {{OUTREACH_END}}) {
      ctx.waitUntil(
        character.fetch(new Request('https://internal/rhythm/checkGap'))
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
