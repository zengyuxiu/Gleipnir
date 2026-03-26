# AgentSight Agent Tool Development Guide

This guide explains how to develop an AI agent tool using Hono and Vercel AI SDK that integrates with AgentSight in a Docker environment.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Docker Deployment](#docker-deployment)
- [API Reference](#api-reference)
- [Integration Guide](#integration-guide)
- [Examples](#examples)
- [Troubleshooting](#troubleshooting)

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Docker Environment                             │
│                                                                          │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐  │
│  │   eBPF Programs  │───▶│   Rust Collector │───▶│   Analyzers      │  │
│  │   (sslsniff,     │    │   (Runners)      │    │   (HTTPParser,   │  │
│  │    process,      │    │                  │    │    SSEProcessor) │  │
│  │    stdiocap)     │    │                  │    │                  │  │
│  └──────────────────┘    └──────────────────┘    └────────┬─────────┘  │
│                                                           │             │
│                                                  ┌────────▼─────────┐   │
│                                                  │   Web Server     │   │
│                                                  │   :7395          │   │
│                                                  │   /api/events    │   │
│                                                  └────────┬─────────┘   │
└───────────────────────────────────────────────────────────┼─────────────┘
                                                             │
                                                     ┌────────▼─────────┐
                                                     │   Agent Tool     │
                                                     │   (Hono + AI SDK)│
                                                     │   :3000          │
                                                     └──────────────────┘
           ```

### Data Flow

1. **eBPF Layer**: Captures SSL/TLS traffic, process events, and stdio payloads at kernel level
2. **Rust Collector**: Processes eBPF events through configurable analyzer chains
3. **Web Server**: Exposes events via REST API and serves the frontend
4. **Agent Tool**: Consumes events and provides AI-powered analysis capabilities

## Prerequisites

### System Requirements

- Docker 20.10+ with Docker Compose
- Linux kernel 5.8+ (for eBPF support)
- `CAP_BPF` and `CAP_SYS_ADMIN` capabilities (or privileged mode)

### Development Requirements

- Node.js 20+
- Rust 1.70+ (for AgentSight development)
- pnpm/npm/yarn

## Quick Start

### 1. Build AgentSight Docker Image

```bash
# Clone the repository
git clone https://github.com/eunomia-bpf/agentsight.git
cd agentsight

# Build the Docker image
docker build -t agentsight:latest -f Dockerfile .
```

### 2. Create Agent Tool Project

```bash
mkdir agent-tool && cd agent-tool
npm init -y
npm install hono @hono/node-server ai @ai-sdk/openai zod
```

### 3. Start with Docker Compose

```bash
docker-compose up -d
```

## Docker Deployment

### Dockerfile for AgentSight

```dockerfile
# Dockerfile
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    clang \
    llvm \
    libelf-dev \
    libbpf-dev \
    linux-headers-generic \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /agentsight
COPY . .

# Build
RUN make build

# Expose web server port
EXPOSE 7395

# Default command
CMD ["./collector/target/release/agentsight", "record", "-c", "claude", "--server"]
```

### Docker Compose Configuration

```yaml
# docker-compose.yml
version: '3.8'

services:
  agentsight:
    build:
      context: .
      dockerfile: Dockerfile
    image: agentsight:latest
    container_name: agentsight
    privileged: true  # Required for eBPF
    volumes:
      - /sys/kernel/debug:/sys/kernel/debug:ro
      - /proc:/proc:ro
      - /lib/modules:/lib/modules:ro
      - agent-data:/data
    ports:
      - "7395:7395"
    environment:
      - RUST_LOG=info
    command: >
      ./collector/target/release/agentsight record
      -c claude
      --binary-path /usr/local/bin/claude
      --server
      --server-port 7395
    networks:
      - agent-network
    restart: unless-stopped

  agent-tool:
    build:
      context: ./agent-tool
      dockerfile: Dockerfile
    container_name: agent-tool
    ports:
      - "3000:3000"
    environment:
      - AGENTSIGHT_URL=http://agentsight:7395
      - OPENAI_API_KEY=${OPENAI_API_KEY}
    depends_on:
      - agentsight
    networks:
      - agent-network
    restart: unless-stopped

volumes:
  agent-data:

networks:
  agent-network:
    driver: bridge
```

### Dockerfile for Agent Tool

```dockerfile
# agent-tool/Dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

EXPOSE 3000

CMD ["node", "dist/index.js"]
```

## API Reference

### AgentSight API Endpoints

#### GET /api/events

Returns captured events as newline-delimited JSON.

**Response:**
```
{"timestamp":1234567890,"source":"ssl","pid":1234,"comm":"claude","data":{...}}
{"timestamp":1234567891,"source":"process","pid":1235,"comm":"node","data":{...}}
```

#### GET /api/assets

Returns list of embedded frontend assets.

**Response:**
```json
{
  "assets": ["index.html", "static/js/main.js", ...],
  "total_count": 42
}
```

### Event Types

#### SSL Event

```typescript
interface SslEvent {
  timestamp: number;      // Milliseconds since epoch
  source: "ssl";
  pid: number;
  comm: string;           // Process name
  data: {
    tid: number;          // Thread ID
    data: string;         // SSL payload (hex or text)
    data_len: number;
    is_write: boolean;    // true=write, false=read
    saddr: string;        // Source address
    daddr: string;        // Destination address
    sport: number;
    dport: number;
  };
}
```

#### HTTP Event (from HTTPParser)

```typescript
interface HttpEvent {
  timestamp: number;
  source: "http";
  pid: number;
  comm: string;
  data: {
    type: "request" | "response";
    tid: number;
    first_line: string;
    method?: string;        // GET, POST, PUT, DELETE, etc.
    path?: string;          // Request path
    protocol?: string;      // HTTP/1.1
    status_code?: number;   // Response status
    status_text?: string;
    headers: Record<string, string>;
    body?: string;
    is_chunked: boolean;
    content_length?: number;
    has_body: boolean;
    total_size: number;
    raw_data?: string;      // Original HTTP message
  };
}
```

#### Process Event

```typescript
interface ProcessEvent {
  timestamp: number;
  source: "process";
  pid: number;
  comm: string;
  data: {
    event: "exec" | "exit" | "fork";
    ppid?: number;
    exit_code?: number;
    args?: string[];
    filename?: string;
  };
}
```

#### System Event

```typescript
interface SystemEvent {
  timestamp: number;
  source: "system";
  pid: number;
  comm: string;
  data: {
    cpu_percent: number;
    memory_mb: number;
    threads: number;
    children?: SystemChildStats[];
  };
}
```

## Integration Guide

### 1. AgentSight Client Implementation

```typescript
// src/clients/agentsight.ts
import type { AgentEvent, HttpEvent, ProcessEvent, SystemEvent } from '../types';

export class AgentSightClient {
  private baseUrl: string;
  private logFile: string;

  constructor(
    baseUrl: string = process.env.AGENTSIGHT_URL || 'http://localhost:7395',
    logFile: string = 'record.log'
  ) {
    this.baseUrl = baseUrl;
    this.logFile = logFile;
  }

  /**
   * Fetch all events from the log file
   */
  async getEvents(): Promise<AgentEvent[]> {
    const response = await fetch(`${this.baseUrl}/api/events`);
    const text = await response.text();

    const events: AgentEvent[] = [];
    for (const line of text.split('\n')) {
      if (line.trim()) {
        try {
          events.push(JSON.parse(line));
        } catch (e) {
          console.warn('Failed to parse event:', line);
        }
      }
    }
    return events;
  }

  /**
   * Stream events as they arrive
   */
  async *streamEvents(): AsyncGenerator<AgentEvent> {
    const response = await fetch(`${this.baseUrl}/api/events`);
    const text = await response.text();

    for (const line of text.split('\n')) {
      if (line.trim()) {
        try {
          yield JSON.parse(line);
        } catch (e) {
          // Skip unparseable lines
        }
      }
    }
  }

  /**
   * Get HTTP events only
   */
  async getHttpEvents(): Promise<HttpEvent[]> {
    const events = await this.getEvents();
    return events.filter(
      (e): e is HttpEvent => e.source === 'http' || e.data?.type === 'request' || e.data?.type === 'response'
    );
  }

  /**
   * Get process events only
   */
  async getProcessEvents(): Promise<ProcessEvent[]> {
    const events = await this.getEvents();
    return events.filter((e): e is ProcessEvent => e.source === 'process');
  }

  /**
   * Get system resource events
   */
  async getSystemEvents(): Promise<SystemEvent[]> {
    const events = await this.getEvents();
    return events.filter((e): e is SystemEvent => e.source === 'system');
  }

  /**
   * Filter events by time range
   */
  async getEventsByTimeRange(start: number, end: number): Promise<AgentEvent[]> {
    const events = await this.getEvents();
    return events.filter(e => e.timestamp >= start && e.timestamp <= end);
  }

  /**
   * Filter events by process name
   */
  async getEventsByComm(comm: string): Promise<AgentEvent[]> {
    const events = await this.getEvents();
    return events.filter(e => e.comm.includes(comm));
  }

  /**
   * Filter events by PID
   */
  async getEventsByPid(pid: number): Promise<AgentEvent[]> {
    const events = await this.getEvents();
    return events.filter(e => e.pid === pid);
  }
}
```

### 2. Type Definitions

```typescript
// src/types/index.ts

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
    tid: number;
    first_line: string;
    method?: string;
    path?: string;
    protocol?: string;
    status_code?: number;
    status_text?: string;
    headers: Record<string, string>;
    body?: string;
    is_chunked: boolean;
    content_length?: number;
    has_body: boolean;
    total_size: number;
    raw_data?: string;
  };
}

export interface ProcessEvent extends AgentEvent {
  source: 'process';
  data: {
    event: 'exec' | 'exit' | 'fork';
    ppid?: number;
    exit_code?: number;
    args?: string[];
    filename?: string;
  };
}

export interface SystemEvent extends AgentEvent {
  source: 'system';
  data: {
    cpu_percent: number;
    memory_mb: number;
    threads: number;
    children?: Array<{
      pid: number;
      comm: string;
      cpu_percent: number;
      memory_mb: number;
    }>;
  };
}

export interface StdioEvent extends AgentEvent {
  source: 'stdio';
  data: {
    fd: number;
    data: string;
    is_write: boolean;
    bytes_captured: number;
  };
}

export interface EventFilter {
  source?: string[];
  comm?: string;
  pid?: number;
  timeRange?: {
    start: number;
    end: number;
  };
  httpMethod?: string;
  pathPattern?: string;
  statusCode?: number;
}
```

### 3. Hono Application with AI Tools

```typescript
// src/index.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { generateText, streamText, tool } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { AgentSightClient } from './clients/agentsight';
import type { AgentEvent, HttpEvent, EventFilter } from './types';

const app = new Hono();

// Enable CORS
app.use('/*', cors());

// Initialize client
const client = new AgentSightClient();

// ============================================
// AI Tools Definition
// ============================================

const getHttpTrafficTool = tool({
  description: 'Retrieve HTTP request/response traffic captured from AI agents',
  parameters: z.object({
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL']).optional(),
    pathPattern: z.string().optional().describe('Regex pattern to filter request paths'),
    statusCode: z.number().optional().describe('Filter by HTTP status code'),
    limit: z.number().optional().default(50),
  }),
  execute: async ({ method, pathPattern, statusCode, limit }) => {
    const events = await client.getHttpEvents();

    let filtered = events;

    if (method && method !== 'ALL') {
      filtered = filtered.filter(e => e.data.method === method);
    }

    if (pathPattern) {
      const regex = new RegExp(pathPattern);
      filtered = filtered.filter(e => e.data.path?.match(regex));
    }

    if (statusCode) {
      filtered = filtered.filter(e => e.data.status_code === statusCode);
    }

    return filtered.slice(0, limit || 50);
  },
});

const analyzeAgentBehaviorTool = tool({
  description: 'Analyze AI agent behavior patterns from captured traffic',
  parameters: z.object({
    query: z.string().describe('Analysis query, e.g., "find all Claude API calls"'),
    timeRangeMinutes: z.number().optional().default(30),
  }),
  execute: async ({ query, timeRangeMinutes }) => {
    const endTime = Date.now();
    const startTime = endTime - (timeRangeMinutes || 30) * 60 * 1000;

    const events = await client.getEventsByTimeRange(startTime, endTime);
    const httpEvents = events.filter(e => e.source === 'http' || e.data?.type);

    // Use LLM to analyze
    const result = await generateText({
      model: openai('gpt-4'),
      prompt: `Analyze the following AI agent HTTP traffic and answer: ${query}

Events (last ${timeRangeMinutes} minutes):
${JSON.stringify(httpEvents.slice(0, 100), null, 2)}

Provide:
1. Key findings
2. API call patterns
3. Potential issues or recommendations`,
    });

    return {
      analysis: result.text,
      eventCount: httpEvents.length,
      timeRange: { start: startTime, end: endTime },
    };
  },
});

const getProcessActivityTool = tool({
  description: 'Get process execution and exit events',
  parameters: z.object({
    comm: z.string().optional().describe('Filter by process name'),
    eventType: z.enum(['exec', 'exit', 'fork', 'all']).optional().default('all'),
    limit: z.number().optional().default(50),
  }),
  execute: async ({ comm, eventType, limit }) => {
    let events = await client.getProcessEvents();

    if (comm) {
      events = events.filter(e => e.comm.includes(comm));
    }

    if (eventType && eventType !== 'all') {
      events = events.filter(e => e.data.event === eventType);
    }

    return events.slice(0, limit || 50);
  },
});

const getResourceUsageTool = tool({
  description: 'Get system resource usage metrics (CPU, memory)',
  parameters: z.object({
    pid: z.number().optional().describe('Filter by PID'),
    comm: z.string().optional().describe('Filter by process name'),
  }),
  execute: async ({ pid, comm }) => {
    let events = await client.getSystemEvents();

    if (pid) {
      events = events.filter(e => e.pid === pid);
    }

    if (comm) {
      events = events.filter(e => e.comm.includes(comm));
    }

    // Calculate aggregates
    const avgCpu = events.reduce((sum, e) => sum + (e.data.cpu_percent || 0), 0) / (events.length || 1);
    const maxMemory = Math.max(...events.map(e => e.data.memory_mb || 0));

    return {
      events: events.slice(-20),  // Last 20 events
      aggregates: {
        avgCpuPercent: avgCpu.toFixed(2),
        maxMemoryMb: maxMemory,
        totalEvents: events.length,
      },
    };
  },
});

const searchEventsTool = tool({
  description: 'Search across all captured events with flexible filters',
  parameters: z.object({
    source: z.array(z.enum(['ssl', 'http', 'process', 'system', 'stdio'])).optional(),
    comm: z.string().optional(),
    pid: z.number().optional(),
    timeRangeStart: z.number().optional(),
    timeRangeEnd: z.number().optional(),
    bodyContains: z.string().optional().describe('Search in HTTP body content'),
    limit: z.number().optional().default(100),
  }),
  execute: async (filters) => {
    let events = await client.getEvents();

    if (filters.source) {
      events = events.filter(e => filters.source!.includes(e.source as any));
    }

    if (filters.comm) {
      events = events.filter(e => e.comm.includes(filters.comm!));
    }

    if (filters.pid) {
      events = events.filter(e => e.pid === filters.pid);
    }

    if (filters.timeRangeStart && filters.timeRangeEnd) {
      events = events.filter(e =>
        e.timestamp >= filters.timeRangeStart! && e.timestamp <= filters.timeRangeEnd!
      );
    }

    if (filters.bodyContains) {
      events = events.filter(e => {
        const body = e.data?.body || '';
        return typeof body === 'string' && body.includes(filters.bodyContains!);
      });
    }

    return events.slice(0, filters.limit || 100);
  },
});

// ============================================
// REST API Endpoints
// ============================================

// Health check
app.get('/health', (c) => c.json({ status: 'ok' }));

// Get all events
app.get('/api/events', async (c) => {
  const events = await client.getEvents();
  return c.json(events);
});

// Get HTTP events
app.get('/api/http', async (c) => {
  const events = await client.getHttpEvents();
  return c.json(events);
});

// Get process events
app.get('/api/process', async (c) => {
  const events = await client.getProcessEvents();
  return c.json(events);
});

// Get system events
app.get('/api/system', async (c) => {
  const events = await client.getSystemEvents();
  return c.json(events);
});

// SSE stream endpoint
app.get('/api/stream', async (c) => {
  return streamSSE(c, async (stream) => {
    for await (const event of client.streamEvents()) {
      await stream.writeSSE({
        data: JSON.stringify(event),
        event: 'agent-event',
      });
    }
  });
});

// ============================================
// AI Agent Endpoints
// ============================================

// Chat with AI about agent behavior
app.post('/api/chat', async (c) => {
  const { messages } = await c.req.json();

  const result = streamText({
    model: openai('gpt-4'),
    system: `You are an AI agent observability assistant. You help users understand and analyze
AI agent behavior by examining HTTP traffic, process events, and system metrics captured by AgentSight.
Use the available tools to fetch and analyze data when needed.`,
    messages,
    tools: {
      getHttpTraffic: getHttpTrafficTool,
      analyzeAgentBehavior: analyzeAgentBehaviorTool,
      getProcessActivity: getProcessActivityTool,
      getResourceUsage: getResourceUsageTool,
      searchEvents: searchEventsTool,
    },
    maxSteps: 5,
  });

  return result.toDataStreamResponse();
});

// Single query endpoint
app.post('/api/analyze', async (c) => {
  const { query } = await c.req.json();

  const result = await generateText({
    model: openai('gpt-4'),
    system: `You are an AI agent observability assistant. Analyze the query and use tools to fetch relevant data.`,
    prompt: query,
    tools: {
      getHttpTraffic: getHttpTrafficTool,
      analyzeAgentBehavior: analyzeAgentBehaviorTool,
      getProcessActivity: getProcessActivityTool,
      getResourceUsage: getResourceUsageTool,
      searchEvents: searchEventsTool,
    },
    maxSteps: 5,
  });

  return c.json({
    result: result.text,
    toolCalls: result.toolCalls,
  });
});

export default app;
```

### 4. Server Entry Point

```typescript
// src/server.ts
import { serve } from '@hono/node-server';
import app from './index';

const port = parseInt(process.env.PORT || '3000');

console.log(`🚀 Agent Tool server running on http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port,
});
```

## Examples

### Example 1: Monitor Claude Code Activity

```typescript
// examples/monitor-claude.ts
import { AgentSightClient } from '../src/clients/agentsight';

async function monitorClaudeCode() {
  const client = new AgentSightClient();

  console.log('Monitoring Claude Code activity...\n');

  for await (const event of client.streamEvents()) {
    if (event.source === 'http') {
      const httpEvent = event as any;
      if (httpEvent.data.type === 'request') {
        console.log(`[${new Date(event.timestamp).toISOString()}] ${httpEvent.data.method} ${httpEvent.data.path}`);
      } else {
        console.log(`[${new Date(event.timestamp).toISOString()}] Response ${httpEvent.data.status_code}`);
      }
    }
  }
}

monitorClaudeCode().catch(console.error);
```

### Example 2: Analyze API Usage Patterns

```typescript
// examples/analyze-api-usage.ts
import { AgentSightClient } from '../src/clients/agentsight';

async function analyzeApiUsage() {
  const client = new AgentSightClient();
  const events = await client.getHttpEvents();

  // Group by endpoint
  const endpoints = new Map<string, { count: number; methods: Set<string> }>();

  for (const event of events) {
    if (event.data.type === 'request' && event.data.path) {
      const path = event.data.path;
      if (!endpoints.has(path)) {
        endpoints.set(path, { count: 0, methods: new Set() });
      }
      const entry = endpoints.get(path)!;
      entry.count++;
      if (event.data.method) {
        entry.methods.add(event.data.method);
      }
    }
  }

  // Sort by frequency
  const sorted = [...endpoints.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10);

  console.log('Top 10 API Endpoints:');
  console.log('=====================');
  for (const [path, stats] of sorted) {
    console.log(`${path}: ${stats.count} calls (${[...stats.methods].join(', ')})`);
  }
}

analyzeApiUsage().catch(console.error);
```

### Example 3: Build Custom Dashboard

```typescript
// examples/dashboard-server.ts
import { Hono } from 'hono';
import { AgentSightClient } from '../src/clients/agentsight';

const app = new Hono();
const client = new AgentSightClient();

// Dashboard stats
app.get('/api/dashboard/stats', async (c) => {
  const events = await client.getEvents();
  const httpEvents = events.filter(e => e.source === 'http' || e.data?.type);
  const processEvents = events.filter(e => e.source === 'process');

  const requests = httpEvents.filter(e => e.data?.type === 'request');
  const responses = httpEvents.filter(e => e.data?.type === 'response');

  const statusCodes = responses.reduce((acc, e) => {
    const code = e.data?.status_code;
    if (code) {
      acc[code] = (acc[code] || 0) + 1;
    }
    return acc;
  }, {} as Record<number, number>);

  return c.json({
    totalEvents: events.length,
    httpRequests: requests.length,
    httpResponses: responses.length,
    processEvents: processEvents.length,
    statusCodes,
    uniqueProcesses: new Set(events.map(e => e.pid)).size,
    timeRange: {
      start: events[0]?.timestamp,
      end: events[events.length - 1]?.timestamp,
    },
  });
});

export default app;
```

### Example 4: Real-time Alert System

```typescript
// examples/alert-system.ts
import { AgentSightClient } from '../src/clients/agentsight';

interface Alert {
  type: 'error' | 'warning' | 'info';
  message: string;
  timestamp: number;
  event: any;
}

class AlertSystem {
  private client: AgentSightClient;
  private alerts: Alert[] = [];

  constructor() {
    this.client = new AgentSightClient();
  }

  async start() {
    console.log('Starting alert system...\n');

    for await (const event of this.client.streamEvents()) {
      this.checkAlerts(event);
    }
  }

  private checkAlerts(event: any) {
    // HTTP 4xx/5xx errors
    if (event.data?.type === 'response') {
      const status = event.data.status_code;
      if (status >= 500) {
        this.alert('error', `Server error: ${status}`, event);
      } else if (status >= 400) {
        this.alert('warning', `Client error: ${status}`, event);
      }
    }

    // High CPU usage
    if (event.source === 'system' && event.data?.cpu_percent > 80) {
      this.alert('warning', `High CPU usage: ${event.data.cpu_percent}%`, event);
    }

    // High memory usage
    if (event.source === 'system' && event.data?.memory_mb > 1000) {
      this.alert('warning', `High memory usage: ${event.data.memory_mb}MB`, event);
    }

    // Process crashes
    if (event.source === 'process' && event.data?.event === 'exit') {
      if (event.data.exit_code !== 0) {
        this.alert('error', `Process crashed: ${event.comm} (exit code: ${event.data.exit_code})`, event);
      }
    }
  }

  private alert(type: Alert['type'], message: string, event: any) {
    const alert: Alert = {
      type,
      message,
      timestamp: Date.now(),
      event,
    };
    this.alerts.push(alert);

    const icon = { error: '🔴', warning: '🟡', info: '🔵' }[type];
    console.log(`${icon} [${new Date().toISOString()}] ${message}`);
  }

  getAlerts() {
    return this.alerts;
  }
}

const system = new AlertSystem();
system.start().catch(console.error);
```

## Troubleshooting

### Common Issues

#### 1. No SSL Events Captured

**Problem**: AgentSight is running but no SSL events appear.

**Solution**:
- Ensure the target application uses dynamically linked OpenSSL, or
- Use `--binary-path` for statically linked SSL (Claude, Bun, NVM Node.js)
- Check that the process is actually making HTTPS requests

```bash
# For Claude Code
sudo ./agentsight record -c claude --binary-path ~/.local/share/claude/versions/<version>

# For NVM Node.js
sudo ./agentsight record -c node --binary-path ~/.nvm/versions/node/v20.0.0/bin/node
```

#### 2. Docker Permission Errors

**Problem**: eBPF programs fail with permission errors in Docker.

**Solution**:
- Use `privileged: true` in docker-compose
- Or grant specific capabilities:

```yaml
services:
  agentsight:
    cap_add:
      - CAP_BPF
      - CAP_SYS_ADMIN
      - CAP_NET_ADMIN
```

#### 3. Empty /api/events Response

**Problem**: API returns empty or sample events.

**Solution**:
- Ensure `--server` flag is used when starting AgentSight
- Check that the log file exists and has content
- Verify the log file path matches the `--log-file` parameter

#### 4. CORS Errors

**Problem**: Browser blocks requests to AgentSight API.

**Solution**: AgentSight already sets `Access-Control-Allow-Origin: *`. If issues persist, use a reverse proxy:

```nginx
server {
    listen 80;

    location / {
        proxy_pass http://agentsight:7395;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

#### 5. High Memory Usage

**Problem**: AgentSight consumes too much memory.

**Solution**:
- Use `--rotate-logs` with `--max-log-size` to limit log file size
- Add filters to reduce event volume:

```bash
sudo ./agentsight record -c claude \
  --http-filter "request.path_prefix=/v1/rgstr | response.status_code=202" \
  --ssl-filter "data=0\\r\\n\\r\\n | data.type=binary"
```

### Debug Mode

Enable debug logging:

```bash
RUST_LOG=debug sudo ./agentsight record -c claude --server
```

### Performance Tuning

For high-throughput scenarios:

```bash
# Increase buffer sizes
sudo ./agentsight record -c claude \
  --rotate-logs \
  --max-log-size 100 \
  --server-port 7395
```

## Additional Resources

- [AgentSight GitHub Repository](https://github.com/eunomia-bpf/agentsight)
- [Hono Documentation](https://hono.dev/)
- [Vercel AI SDK](https://sdk.vercel.ai/)
- [eBPF Documentation](https://ebpf.io/)
