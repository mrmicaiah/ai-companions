// ============================================================
// COMPANIONS ADMIN - Central Management API
// Version: 2.0.0 - Website integration
// ============================================================

interface Env {
  PLATFORM_BUCKET: R2Bucket;
  ADMIN_SECRET: string;
}

interface CharacterPublic {
  name: string;
  display_name: string;
  tagline: string;
  domain: string;
  core_question: string;
  age: number;
  occupation: string;
  location: string;
  telegram_username: string;
  telegram_link: string;
  avatar_url?: string;
  status: 'active' | 'paused' | 'coming_soon';
}

interface CharacterFull extends CharacterPublic {
  worker_url: string;
  bucket_name: string;
  created_at: string;
  updated_at: string;
  telegram_bot_token?: string;
}

interface Registry {
  characters: CharacterFull[];
  updated_at: string;
}

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}

function checkAuth(request: Request, env: Env): boolean {
  const auth = request.headers.get('Authorization');
  return auth === `Bearer ${env.ADMIN_SECRET}`;
}

// Strip sensitive fields for public API
function toPublic(char: CharacterFull): CharacterPublic {
  return {
    name: char.name,
    display_name: char.display_name,
    tagline: char.tagline,
    domain: char.domain,
    core_question: char.core_question,
    age: char.age,
    occupation: char.occupation,
    location: char.location,
    telegram_username: char.telegram_username,
    telegram_link: char.telegram_link,
    avatar_url: char.avatar_url,
    status: char.status
  };
}

async function getRegistry(env: Env): Promise<Registry> {
  const obj = await env.PLATFORM_BUCKET.get('registry/characters.json');
  if (!obj) {
    return { characters: [], updated_at: new Date().toISOString() };
  }
  return JSON.parse(await obj.text());
}

async function saveRegistry(env: Env, registry: Registry): Promise<void> {
  registry.updated_at = new Date().toISOString();
  await env.PLATFORM_BUCKET.put(
    'registry/characters.json',
    JSON.stringify(registry, null, 2)
  );
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
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
      });
    }

    // ==================== PUBLIC ENDPOINTS ====================

    // Health check
    if (url.pathname === '/health') {
      return jsonResponse({ 
        status: 'ok', 
        service: 'companions-admin',
        version: '2.0.0'
      });
    }

    // PUBLIC: List all active characters (for website)
    if (url.pathname === '/api/characters' && method === 'GET') {
      const registry = await getRegistry(env);
      const activeCharacters = registry.characters
        .filter(c => c.status === 'active' || c.status === 'coming_soon')
        .map(toPublic);
      
      return jsonResponse({ 
        characters: activeCharacters,
        count: activeCharacters.length
      });
    }

    // PUBLIC: Get single character (for website)
    if (url.pathname.match(/^\/api\/characters\/[a-z]+$/) && method === 'GET') {
      const name = url.pathname.split('/').pop();
      const registry = await getRegistry(env);
      const char = registry.characters.find(c => c.name === name);
      
      if (!char || char.status === 'paused') {
        return jsonResponse({ error: 'Character not found' }, 404);
      }
      
      return jsonResponse(toPublic(char));
    }

    // PUBLIC: Get characters by domain (for website filtering)
    if (url.pathname === '/api/characters/by-domain' && method === 'GET') {
      const domain = url.searchParams.get('domain');
      const registry = await getRegistry(env);
      
      let characters = registry.characters.filter(c => c.status === 'active');
      if (domain) {
        characters = characters.filter(c => c.domain.toLowerCase() === domain.toLowerCase());
      }
      
      return jsonResponse({ 
        characters: characters.map(toPublic),
        count: characters.length
      });
    }

    // ==================== ADMIN ENDPOINTS ====================

    // ADMIN: List all characters (including paused, full details)
    if (url.pathname === '/admin/characters' && method === 'GET') {
      if (!checkAuth(request, env)) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }
      
      const registry = await getRegistry(env);
      return jsonResponse({ 
        characters: registry.characters,
        count: registry.characters.length,
        updated_at: registry.updated_at
      });
    }

    // ADMIN: Register or update character
    if (url.pathname === '/admin/characters' && method === 'POST') {
      if (!checkAuth(request, env)) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }
      
      const data = await request.json() as Partial<CharacterFull>;
      
      if (!data.name || !data.display_name) {
        return jsonResponse({ error: 'Missing required fields: name, display_name' }, 400);
      }

      const registry = await getRegistry(env);
      const existingIndex = registry.characters.findIndex(c => c.name === data.name);
      
      const now = new Date().toISOString();
      
      const character: CharacterFull = {
        name: data.name,
        display_name: data.display_name,
        tagline: data.tagline || '',
        domain: data.domain || '',
        core_question: data.core_question || '',
        age: data.age || 0,
        occupation: data.occupation || '',
        location: data.location || '',
        telegram_username: data.telegram_username || '',
        telegram_link: data.telegram_username ? `https://t.me/${data.telegram_username}` : '',
        avatar_url: data.avatar_url,
        status: data.status || 'coming_soon',
        worker_url: data.worker_url || '',
        bucket_name: data.bucket_name || `${data.name}-memory`,
        telegram_bot_token: data.telegram_bot_token,
        created_at: existingIndex >= 0 ? registry.characters[existingIndex].created_at : now,
        updated_at: now
      };

      if (existingIndex >= 0) {
        registry.characters[existingIndex] = character;
      } else {
        registry.characters.push(character);
      }

      await saveRegistry(env, registry);
      
      return jsonResponse({ 
        success: true, 
        character: toPublic(character),
        action: existingIndex >= 0 ? 'updated' : 'created'
      });
    }

    // ADMIN: Update character status
    if (url.pathname.match(/^\/admin\/characters\/[a-z]+$/) && method === 'PATCH') {
      if (!checkAuth(request, env)) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }
      
      const name = url.pathname.split('/').pop();
      const updates = await request.json() as Partial<CharacterFull>;
      
      const registry = await getRegistry(env);
      const idx = registry.characters.findIndex(c => c.name === name);
      
      if (idx < 0) {
        return jsonResponse({ error: 'Character not found' }, 404);
      }

      // Update telegram_link if username changed
      if (updates.telegram_username) {
        updates.telegram_link = `https://t.me/${updates.telegram_username}`;
      }

      registry.characters[idx] = { 
        ...registry.characters[idx], 
        ...updates,
        updated_at: new Date().toISOString()
      };
      
      await saveRegistry(env, registry);
      
      return jsonResponse({ 
        success: true, 
        character: toPublic(registry.characters[idx])
      });
    }

    // ADMIN: Delete character
    if (url.pathname.match(/^\/admin\/characters\/[a-z]+$/) && method === 'DELETE') {
      if (!checkAuth(request, env)) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }
      
      const name = url.pathname.split('/').pop();
      const registry = await getRegistry(env);
      const idx = registry.characters.findIndex(c => c.name === name);
      
      if (idx < 0) {
        return jsonResponse({ error: 'Character not found' }, 404);
      }

      registry.characters.splice(idx, 1);
      await saveRegistry(env, registry);
      
      return jsonResponse({ success: true, deleted: name });
    }

    // ADMIN: Bulk register characters
    if (url.pathname === '/admin/characters/bulk' && method === 'POST') {
      if (!checkAuth(request, env)) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }
      
      const { characters } = await request.json() as { characters: Partial<CharacterFull>[] };
      
      if (!characters || !Array.isArray(characters)) {
        return jsonResponse({ error: 'Expected { characters: [...] }' }, 400);
      }

      const registry = await getRegistry(env);
      const now = new Date().toISOString();
      const results: { name: string; action: string }[] = [];

      for (const data of characters) {
        if (!data.name || !data.display_name) continue;

        const existingIndex = registry.characters.findIndex(c => c.name === data.name);
        
        const character: CharacterFull = {
          name: data.name,
          display_name: data.display_name,
          tagline: data.tagline || '',
          domain: data.domain || '',
          core_question: data.core_question || '',
          age: data.age || 0,
          occupation: data.occupation || '',
          location: data.location || '',
          telegram_username: data.telegram_username || '',
          telegram_link: data.telegram_username ? `https://t.me/${data.telegram_username}` : '',
          avatar_url: data.avatar_url,
          status: data.status || 'coming_soon',
          worker_url: data.worker_url || '',
          bucket_name: data.bucket_name || `${data.name}-memory`,
          telegram_bot_token: data.telegram_bot_token,
          created_at: existingIndex >= 0 ? registry.characters[existingIndex].created_at : now,
          updated_at: now
        };

        if (existingIndex >= 0) {
          registry.characters[existingIndex] = character;
          results.push({ name: data.name, action: 'updated' });
        } else {
          registry.characters.push(character);
          results.push({ name: data.name, action: 'created' });
        }
      }

      await saveRegistry(env, registry);
      
      return jsonResponse({ success: true, results });
    }

    // Debug: list bucket contents
    if (url.pathname === '/admin/debug/bucket' && method === 'GET') {
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
