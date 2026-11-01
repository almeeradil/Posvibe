import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const DATA_DIR = path.resolve(process.cwd(), 'data');
const STORE_FILE = path.join(DATA_DIR, 'posvibe_store.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// In-memory cloud sync store: maps userEmail -> { data: userData, lastUpdated: timestamp, accounts: userAccounts }
interface UserStore {
  [email: string]: {
    data: any;
    accounts?: any;
    lastUpdated: number;
    profile?: {
      email: string;
      name?: string;
      picture?: string;
      lastLogin?: string;
    };
  };
}

let memoryStore: UserStore = {};

// Load persisted data if exists
try {
  if (fs.existsSync(STORE_FILE)) {
    const raw = fs.readFileSync(STORE_FILE, 'utf-8');
    memoryStore = JSON.parse(raw);
  }
} catch (err) {
  console.error('Error loading persisted store:', err);
  memoryStore = {};
}

function persistStore() {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(memoryStore, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving store to disk:', err);
  }
}

// Active Server-Sent Events (SSE) connections grouped by user email for real-time push
const sseClientsByEmail: { [email: string]: Response[] } = {};

function broadcastSync(email: string, payload: any, senderDeviceId?: string) {
  const normalizedEmail = email.toLowerCase().trim();
  const clients = sseClientsByEmail[normalizedEmail];
  if (!clients || clients.length === 0) return;

  const message = JSON.stringify({
    type: 'sync',
    email: normalizedEmail,
    data: payload.data,
    senderDeviceId: senderDeviceId || '',
    timestamp: Date.now(),
  });

  const eventData = `event: sync\ndata: ${message}\n\n`;

  for (let i = clients.length - 1; i >= 0; i--) {
    const res = clients[i];
    try {
      res.write(eventData);
    } catch {
      clients.splice(i, 1);
    }
  }
}

// Optional Gemini client initialized with user API key if configured
let aiClient: GoogleGenAI | null = null;
if (process.env.GEMINI_API_KEY) {
  try {
    aiClient = new GoogleGenAI();
  } catch (err) {
    console.warn('Could not initialize GoogleGenAI client:', err);
  }
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Health check
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    app: 'PosVibe',
    time: new Date().toISOString(),
    geminiConfigured: !!process.env.GEMINI_API_KEY,
  });
});

// Real-time Server-Sent Events stream
app.get('/api/sync/stream', (req: Request, res: Response) => {
  const emailParam = req.query.email as string;
  if (!emailParam) {
    res.status(400).json({ error: 'Email parameter required' });
    return;
  }
  const email = emailParam.toLowerCase().trim();

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  if (!sseClientsByEmail[email]) {
    sseClientsByEmail[email] = [];
  }
  sseClientsByEmail[email].push(res);

  // Send initial connection acknowledgement
  res.write(
    `event: connected\ndata: ${JSON.stringify({
      status: 'connected',
      email,
      timestamp: Date.now(),
      connectedClientsCount: sseClientsByEmail[email].length,
    })}\n\n`
  );

  // Heartbeat every 15s to keep connection open through reverse proxies
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const clients = sseClientsByEmail[email];
    if (clients) {
      const idx = clients.indexOf(res);
      if (idx !== -1) {
        clients.splice(idx, 1);
      }
      if (clients.length === 0) {
        delete sseClientsByEmail[email];
      }
    }
  });
});

function mergeUserData(existing: any, incoming: any) {
  if (!existing || typeof existing !== 'object') return incoming;
  if (!incoming || typeof incoming !== 'object') return existing;

  const result: any = { ...existing, ...incoming };

  const collections = [
    'orders', 'purchaseinvoices', 'quotations', 'patients', 'debitnotes',
    'inventory', 'customers', 'suppliers', 'purchases', 'payouts',
    'expenses', 'salaries', 'attendance', 'cashbank', 'otherincome', 'activities'
  ];

  collections.forEach(col => {
    const incArr = Array.isArray(incoming[col]) ? incoming[col] : null;
    const exArr = Array.isArray(existing[col]) ? existing[col] : null;

    if (incArr !== null && (incArr.length > 0 || !exArr || exArr.length === 0)) {
      result[col] = incArr;
    } else if (exArr !== null) {
      result[col] = exArr;
    } else {
      result[col] = [];
    }
  });

  result.settings = { ...(existing.settings || {}), ...(incoming.settings || {}) };
  result.counters = { ...(existing.counters || {}), ...(incoming.counters || {}) };

  return result;
}

// Fetch latest cloud-synced data for an account
app.get('/api/sync/data', (req: Request, res: Response) => {
  const emailParam = req.query.email as string;
  if (!emailParam) {
    res.status(400).json({ error: 'Email parameter required' });
    return;
  }
  const email = emailParam.toLowerCase().trim();

  if (!memoryStore[email] && fs.existsSync(STORE_FILE)) {
    try {
      const raw = fs.readFileSync(STORE_FILE, 'utf-8');
      memoryStore = JSON.parse(raw);
    } catch {}
  }

  const entry = memoryStore[email];

  if (entry) {
    res.json({
      success: true,
      email,
      data: entry.data || null,
      accounts: entry.accounts || null,
      lastUpdated: entry.lastUpdated,
      profile: entry.profile || null,
    });
  } else {
    res.json({
      success: true,
      email,
      data: null,
      accounts: null,
      lastUpdated: 0,
      profile: null,
    });
  }
});

// Push updated data from any laptop/device and broadcast to all connected devices in real time
app.post('/api/sync/update', (req: Request, res: Response) => {
  const { email, data, accounts, deviceId, profile } = req.body;
  if (!email) {
    res.status(400).json({ error: 'Email is required' });
    return;
  }

  const normalizedEmail = String(email).toLowerCase().trim();
  const now = Date.now();

  if (!memoryStore[normalizedEmail] && fs.existsSync(STORE_FILE)) {
    try {
      const raw = fs.readFileSync(STORE_FILE, 'utf-8');
      memoryStore = JSON.parse(raw);
    } catch {}
  }

  const existingData = memoryStore[normalizedEmail]?.data;
  const mergedData = mergeUserData(existingData, data);

  memoryStore[normalizedEmail] = {
    data: mergedData,
    accounts: accounts || memoryStore[normalizedEmail]?.accounts,
    lastUpdated: now,
    profile: profile || memoryStore[normalizedEmail]?.profile || { email: normalizedEmail },
  };

  persistStore();

  // Broadcast in real-time to all other open sessions/laptops for this Google account
  broadcastSync(normalizedEmail, { data: mergedData }, deviceId);

  res.json({
    success: true,
    email: normalizedEmail,
    lastUpdated: now,
    message: 'Data synchronized in real time across devices',
  });
});

// Google Authentication & profile registration
app.post('/api/auth/google', (req: Request, res: Response) => {
  const { email, name, picture, consentAccepted } = req.body;
  if (!email) {
    res.status(400).json({ error: 'Email is required' });
    return;
  }

  const normalizedEmail = String(email).toLowerCase().trim();
  const now = Date.now();

  if (!memoryStore[normalizedEmail]) {
    memoryStore[normalizedEmail] = {
      data: null,
      lastUpdated: now,
      profile: {
        email: normalizedEmail,
        name: name || normalizedEmail.split('@')[0],
        picture: picture || '',
        lastLogin: new Date().toISOString(),
      },
    };
    persistStore();
  } else {
    // Update profile
    memoryStore[normalizedEmail].profile = {
      email: normalizedEmail,
      name: name || memoryStore[normalizedEmail].profile?.name,
      picture: picture || memoryStore[normalizedEmail].profile?.picture,
      lastLogin: new Date().toISOString(),
    };
    persistStore();
  }

  res.json({
    success: true,
    email: normalizedEmail,
    profile: memoryStore[normalizedEmail].profile,
    cloudData: memoryStore[normalizedEmail].data,
    lastUpdated: memoryStore[normalizedEmail].lastUpdated,
  });
});

// Start server
async function startServer() {
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve(process.cwd(), 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(process.cwd(), 'dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`PosVibe full-stack server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start PosVibe server:', err);
});
