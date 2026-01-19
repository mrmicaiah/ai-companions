import { Hono } from 'hono';
import { cors } from 'hono/cors';

interface Env {
  PLATFORM_BUCKET: R2Bucket;
  ADMIN_SECRET: string;
  ANTHROPIC_API_KEY: string;
  SENDBLUE_API_KEY: string;
  SENDBLUE_API_SECRET: string;
}

interface CharacterRegistration {
  name: string;
  display_name: string;
  tagline?: string;
  phone: string;
  worker_url: string;
  user_phone: string;
  bucket_name: string;
  created_at: string;
  personality_summary?: string;
}

interface CharacterEntry {
  name: string;
  display_name: string;
  created_at: string;
  status: 'active' | 'paused' | 'archived';
  phone: string;
  worker_url: string;
  tagline?: string;
}

interface Registry {
  characters: CharacterEntry[];
}

interface PhoneMap {
  [phone: string]: {
    name: string;
    worker: string;
  };
}

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

// Auth middleware helper
function checkAuth(c: any): boolean {
  const auth = c.req.header('Authorization');
  return auth === `Bearer ${c.env.ADMIN_SECRET}`;
}

// Health check
app.get('/health', (c) => {
  return c.json({ 
    status: 'ok', 
    service: 'companions-admin',
    version: '1.0.0'
  });
});

// List all characters
app.get('/characters', async (c) => {
  if (!checkAuth(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const registry = await c.env.PLATFORM_BUCKET.get('registry/characters.json');
  if (!registry) {
    return c.json({ characters: [] });
  }
  
  return c.json(JSON.parse(await registry.text()));
});

// Get character details
app.get('/characters/:name', async (c) => {
  if (!checkAuth(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const name = c.req.param('name');
  const config = await c.env.PLATFORM_BUCKET.get(`characters/${name}/config.json`);
  
  if (!config) {
    return c.json({ error: 'Character not found' }, 404);
  }
  
  return c.json(JSON.parse(await config.text()));
});

// Register new character
app.post('/characters', async (c) => {
  if (!checkAuth(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const data = await c.req.json<CharacterRegistration>();
  
  // Validate required fields
  if (!data.name || !data.display_name || !data.phone || !data.worker_url) {
    return c.json({ error: 'Missing required fields: name, display_name, phone, worker_url' }, 400);
  }
  
  // Save character config
  await c.env.PLATFORM_BUCKET.put(
    `characters/${data.name}/config.json`,
    JSON.stringify(data, null, 2)
  );
  
  // Update registry
  const registryObj = await c.env.PLATFORM_BUCKET.get('registry/characters.json');
  const registry: Registry = registryObj 
    ? JSON.parse(await registryObj.text()) 
    : { characters: [] };
  
  // Check if character already exists
  const existingIndex = registry.characters.findIndex(ch => ch.name === data.name);
  const entry: CharacterEntry = {
    name: data.name,
    display_name: data.display_name,
    created_at: data.created_at || new Date().toISOString(),
    status: 'active',
    phone: data.phone,
    worker_url: data.worker_url,
    tagline: data.tagline
  };
  
  if (existingIndex >= 0) {
    registry.characters[existingIndex] = entry;
  } else {
    registry.characters.push(entry);
  }
  
  await c.env.PLATFORM_BUCKET.put(
    'registry/characters.json',
    JSON.stringify(registry, null, 2)
  );
  
  // Update phone map
  const phoneMapObj = await c.env.PLATFORM_BUCKET.get('registry/phone-map.json');
  const phoneMap: PhoneMap = phoneMapObj 
    ? JSON.parse(await phoneMapObj.text()) 
    : {};
  
  phoneMap[data.phone] = {
    name: data.name,
    worker: data.name
  };
  
  await c.env.PLATFORM_BUCKET.put(
    'registry/phone-map.json',
    JSON.stringify(phoneMap, null, 2)
  );
  
  return c.json({ success: true, character: data.name });
});

// Update character status
app.patch('/characters/:name', async (c) => {
  if (!checkAuth(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const name = c.req.param('name');
  const updates = await c.req.json<Partial<CharacterEntry>>();
  
  // Get existing config
  const configObj = await c.env.PLATFORM_BUCKET.get(`characters/${name}/config.json`);
  if (!configObj) {
    return c.json({ error: 'Character not found' }, 404);
  }
  
  const config = JSON.parse(await configObj.text());
  const updatedConfig = { ...config, ...updates };
  
  await c.env.PLATFORM_BUCKET.put(
    `characters/${name}/config.json`,
    JSON.stringify(updatedConfig, null, 2)
  );
  
  // Update registry entry too
  const registryObj = await c.env.PLATFORM_BUCKET.get('registry/characters.json');
  if (registryObj) {
    const registry: Registry = JSON.parse(await registryObj.text());
    const idx = registry.characters.findIndex(ch => ch.name === name);
    if (idx >= 0) {
      registry.characters[idx] = { ...registry.characters[idx], ...updates };
      await c.env.PLATFORM_BUCKET.put(
        'registry/characters.json',
        JSON.stringify(registry, null, 2)
      );
    }
  }
  
  return c.json({ success: true, character: name });
});

// Centralized webhook router - routes incoming messages to correct character
app.post('/webhooks/sendblue', async (c) => {
  const data = await c.req.json<any>();
  const toNumber = data.to_number || data.number;
  
  // Look up which character owns this number
  const registryObj = await c.env.PLATFORM_BUCKET.get('registry/phone-map.json');
  if (!registryObj) {
    console.log('No phone registry found');
    return c.json({ error: 'No phone registry' }, 500);
  }
  
  const phoneMap: PhoneMap = JSON.parse(await registryObj.text());
  const character = phoneMap[toNumber];
  
  if (!character) {
    console.log('Unknown phone number:', toNumber);
    return c.json({ error: 'Unknown number' }, 404);
  }
  
  // Forward to character's worker
  const workerUrl = `https://${character.worker}.micaiah-tasks.workers.dev/imessage`;
  
  try {
    await fetch(workerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    
    return c.json({ routed: true, character: character.name });
  } catch (error) {
    console.error('Failed to route to character:', error);
    return c.json({ error: 'Failed to route message' }, 500);
  }
});

// Debug: list bucket contents
app.get('/debug/bucket', async (c) => {
  if (!checkAuth(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const list = await c.env.PLATFORM_BUCKET.list();
  return c.json({
    objects: list.objects.map(o => ({
      key: o.key,
      size: o.size,
      uploaded: o.uploaded
    }))
  });
});

export default app;
