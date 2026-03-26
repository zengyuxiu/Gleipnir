# AgentSight Agent Tool Quick Start Template

This is a minimal template for building an AI agent tool with Hono and Vercel AI SDK that integrates with AgentSight.

## Quick Start

```bash
# 1. Copy this template
cp -r docs/agent-tool-template ./my-agent-tool
cd my-agent-tool

# 2. Install dependencies
npm install

# 3. Set environment variables
export AGENTSIGHT_URL=http://localhost:7395
export OPENAI_API_KEY=your-api-key

# 4. Start development server
npm run dev
```

## Project Structure

```
my-agent-tool/
├── src/
│   ├── index.ts          # Main application
│   ├── types.ts          # TypeScript types
│   └── client.ts         # AgentSight client
├── package.json
├── tsconfig.json
└── Dockerfile
```

## Files

### package.json

```json
{
  "name": "agentsight-agent-tool",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@hono/node-server": "^1.8.0",
    "@ai-sdk/openai": "^0.0.40",
    "ai": "^3.0.0",
    "hono": "^4.0.0",
    "zod": "^3.22.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "tsx": "^4.7.0",
    "typescript": "^5.0.0"
  }
}
```

### src/types.ts

```typescript
export interface AgentEvent {
  timestamp: number;
  source: 'ssl' | 'process' | 'system' | 'http' | 'stdio';
  pid: number;
  comm: string;
  data: Record<string, unknown>;
}

export interface HttpEvent extends AgentEvent {
  source: 'http';
  data: {
    type: 'request' | 'response';
    method?: string;
    path?: string;
    status_code?: number;
    headers: Record<string, string>;
    body?: string;
  };
}
```

### src/client.ts

```typescript
import type { AgentEvent, HttpEvent } from './types';

export class AgentSightClient {
  private baseUrl: string;

  constructor(baseUrl: string = process.env.AGENTSIGHT_URL || 'http://localhost:7395') {
    this.baseUrl = baseUrl;
  }

  async getEvents(): Promise<AgentEvent[]> {
    const response = await fetch(`${this.baseUrl}/api/events`);
    const text = await response.text();

    const events: AgentEvent[] = [];
    for (const line of text.split('\n')) {
      if (line.trim()) {
        try {
          events.push(JSON.parse(line));
        } catch {}
      }
    }
    return events;
  }

  async getHttpEvents(): Promise<HttpEvent[]> {
    const events = await this.getEvents();
    return events.filter(
      (e): e is HttpEvent => e.source === 'http' || !!e.data?.type
    );
  }
}
```

### src/index.ts

```typescript
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { generateText, tool } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { AgentSightClient } from './client';

const app = new Hono();
app.use('/*', cors());

const client = new AgentSightClient();

// Define AI tool
const getHttpTrafficTool = tool({
  description: 'Get HTTP traffic from monitored AI agents',
  parameters: z.object({
    method: z.string().optional(),
    limit: z.number().optional().default(50),
  }),
  execute: async ({ method, limit }) => {
    const events = await client.getHttpEvents();
    let filtered = events;
    if (method) {
      filtered = filtered.filter(e => e.data.method === method);
    }
    return filtered.slice(0, limit);
  },
});

// REST endpoints
app.get('/health', (c) => c.json({ status: 'ok' }));

app.get('/api/events', async (c) => {
  const events = await client.getEvents();
  return c.json(events);
});

app.get('/api/http', async (c) => {
  const events = await client.getHttpEvents();
  return c.json(events);
});

// AI analysis endpoint
app.post('/api/analyze', async (c) => {
  const { query } = await c.req.json();

  const result = await generateText({
    model: openai('gpt-4'),
    prompt: query,
    tools: { getHttpTraffic: getHttpTrafficTool },
    maxSteps: 3,
  });

  return c.json({ result: result.text });
});

export default app;
```

## Docker Deployment

### Dockerfile

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

EXPOSE 3000
CMD ["node", "dist/index.js"]
```

### docker-compose.yml

```yaml
version: '3.8'

services:
  agentsight:
    image: agentsight:latest
    privileged: true
    volumes:
      - /sys/kernel/debug:/sys/kernel/debug:ro
      - /proc:/proc:ro
    ports:
      - "7395:7395"
    command: ./collector/target/release/agentsight record -c claude --server

  agent-tool:
    build: .
    ports:
      - "3000:3000"
    environment:
      - AGENTSIGHT_URL=http://agentsight:7395
      - OPENAI_API_KEY=${OPENAI_API_KEY}
    depends_on:
      - agentsight
```

## Usage Examples

### Get all events

```bash
curl http://localhost:3000/api/events
```

### Get HTTP traffic

```bash
curl http://localhost:3000/api/http
```

### AI analysis

```bash
curl -X POST http://localhost:3000/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"query": "What API endpoints has the agent called?"}'
```

### From JavaScript/TypeScript

```typescript
// Get events
const response = await fetch('http://localhost:3000/api/events');
const events = await response.json();

// AI analysis
const analysis = await fetch('http://localhost:3000/api/analyze', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: 'Analyze the agent API usage patterns'
  })
});
const result = await analysis.json();
```
