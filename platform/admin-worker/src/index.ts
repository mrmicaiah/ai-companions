// ============================================================
// COMPANIONS ADMIN - Central Management API
// Version: 1.0.1 - Removed hono dependency
// ============================================================

interface Env {
  PLATFORM_BUCKET: R2Bucket;
  ADMIN_SECRET: string;
}

interface CharacterRegistration {
  name: string;
  display_name: string;
  tagline?: string;
  telegram_bot_token: string;
  telegram_chat_id: string;
  worker_url: string;
  bucket_name: string;
  created_at: string;
  personality_summary?: string;
}

interface CharacterEntry {
  name: string;
  display_name: string;
  created_at: string;
  status: 'active' | 'paused' | 'archived';
  telegram_bot_username: string;
  worker_url: string;
  tagline?: string;
}

interface Registry {
  characters: CharacterEntry[];
}

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}

function checkAuth(request: Request, env: Env): boolean {
  const auth = request.headers.get('Authorization');
  return auth === `Bearer ${env.ADMIN_SECRET}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
      });
    }

    // Health check
    if (url.pathname === '/health') {
      return jsonResponse({ 
        status: 'ok', 
        service: 'companions-admin',
        version: '1.0.1',
        messaging: 'telegram'
      });
    }

    // List all characters
    if (url.pathname === '/characters' && method === 'GET') {
      if (!checkAuth(request, env)) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }
      
      const registry = await env.PLATFORM_BUCKET.get('registry/characters.json');
      if (!registry) {
        return jsonResponse({ characters: [] });
      }
      
      return jsonResponse(JSON.parse(await registry.text()));
    }

    // Get character details
    if (url.pathname.startsWith('/characters/') && method === 'GET') {
      if (!checkAuth(request, env)) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }
      
      const name = url.pathname.split('/').pop();
      const config = await env.PLATFORM_BUCKET.get(`characters/${name}/config.json`);
      
      if (!config) {
        return jsonResponse({ error: 'Character not found' }, 404);
      }
      
      return jsonResponse(JSON.parse(await config.text()));
    }

    // Register new character
    if (url.pathname === '/characters' && method === 'POST') {
      if (!checkAuth(request, env)) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }
      
      const data = await request.json() as CharacterRegistration;
      
      if (!data.name || !data.display_name || !data.worker_url) {
        return jsonResponse({ error: 'Missing required fields: name, display_name, worker_url' }, 400);
      }
      
      await env.PLATFORM_BUCKET.put(
        `characters/${data.name}/config.json`,
        JSON.stringify(data, null, 2)
      );
      
      const registryObj = await env.PLATFORM_BUCKET.get('registry/characters.json');
      const registry: Registry = registryObj 
        ? JSON.parse(await registryObj.text()) 
        : { characters: [] };
      
      const existingIndex = registry.characters.findIndex(ch => ch.name === data.name);
      const entry: CharacterEntry = {
        name: data.name,
        display_name: data.display_name,
        created_at: data.created_at || new Date().toISOString(),
        status: 'active',
        telegram_bot_username: '',
        worker_url: data.worker_url,
        tagline: data.tagline
      };
      
      if (existingIndex >= 0) {
        registry.characters[existingIndex] = entry;
      } else {
        registry.characters.push(entry);
      }
      
      await env.PLATFORM_BUCKET.put(
        'registry/characters.json',
        JSON.stringify(registry, null, 2)
      );
      
      return jsonResponse({ success: true, character: data.name });
    }

    // Update character status
    if (url.pathname.startsWith('/characters/') && method === 'PATCH') {
      if (!checkAuth(request, env)) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }
      
      const name = url.pathname.split('/').pop();
      const updates = await request.json() as Partial<CharacterEntry>;
      
      const configObj = await env.PLATFORM_BUCKET.get(`characters/${name}/config.json`);
      if (!configObj) {
        return jsonResponse({ error: 'Character not found' }, 404);
      }
      
      const config = JSON.parse(await configObj.text());
      const updatedConfig = { ...config, ...updates };
      
      await env.PLATFORM_BUCKET.put(
        `characters/${name}/config.json`,
        JSON.stringify(updatedConfig, null, 2)
      );
      
      const registryObj = await env.PLATFORM_BUCKET.get('registry/characters.json');
      if (registryObj) {
        const registry: Registry = JSON.parse(await registryObj.text());
        const idx = registry.characters.findIndex(ch => ch.name === name);
        if (idx >= 0) {
          registry.characters[idx] = { ...registry.characters[idx], ...updates };
          await env.PLATFORM_BUCKET.put(
            'registry/characters.json',
            JSON.stringify(registry, null, 2)
          );
        }
      }
      
      return jsonResponse({ success: true, character: name });
    }

    // Debug: list bucket contents
    if (url.pathname === '/debug/bucket' && method === 'GET') {
      if (!checkAuth(request, env)) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }
      
      const list = await env.PLATFORM_BUCKET.list();
      return jsonResponse({
        objects: list.objects.map(o => ({
          key: o.key,
          size: o.size,
          uploaded: o.uploaded
        }))
      });
    }

    return jsonResponse({ error: 'Not found' }, 404);
  }
};
