# SSE Processor Documentation

## Overview

The SSE Processor is an analyzer that merges Server-Sent Events (SSE) content fragments from streaming API responses (like Claude API) into complete, readable messages.

## Purpose

When monitoring AI agents that use streaming APIs, SSL traffic is captured in fragments. The SSE Processor:
- Detects SSE patterns in SSL traffic
- Accumulates fragmented SSE events by connection
- Merges `content_block_delta` events into complete text/JSON responses
- Emits a single consolidated event when the stream completes

## Key Functions

### Detection

```rust
SSEProcessor::is_sse_data(data: &str) -> bool
```

Detects if SSL data contains SSE events by checking for:
- `event:` and `data:` patterns
- `Content-Type: text/event-stream` headers
- Chunked encoding with SSE events
- Standalone `data:` fields with double newlines

### Parsing

```rust
SSEProcessor::parse_sse_events(data: &str) -> Vec<SSEEvent>
```

Parses raw SSL data into structured SSE events:
1. Cleans HTTP chunked encoding artifacts
2. Splits by double newlines (`\n\n`) to separate events
3. Extracts `event:`, `data:`, and `id:` fields
4. Attempts JSON parsing of data fields

### Content Accumulation

```rust
SSEProcessor::accumulate_content(accumulator: &mut SSEAccumulator, events: &[SSEEvent], debug: bool)
```

Accumulates content from streaming events:
- Extracts text from `content_block_delta` events with `text_delta` type
- Extracts thinking from `thinking_delta` type
- Accumulates partial JSON from `partial_json` fields
- Tracks `message_start` events for message ID extraction

### Stream Completion

```rust
SSEProcessor::is_sse_complete(accumulator: &SSEAccumulator) -> bool
```

Determines when an SSE stream is complete:
- Primary indicator: `message_stop` event (Claude API standard)
- Secondary indicator: `error` event
- Fallback: buffer size exceeds 50KB (safety measure)

## Usage

```rust
use agentsight::framework::analyzers::SSEProcessor;

let sse_processor = SSEProcessor::new_with_timeout(30_000);
let processed_stream = ssl_runner
    .add_analyzer(Box::new(sse_processor))
    .run()
    .await?;
```

## Event Structure

### Input: SSL Events
Raw SSL traffic fragments containing SSE data.

### Output: Merged SSE Events
```json
{
  "source": "sse_processor",
  "event_type": "sse_merged",
  "data": {
    "connection_id": "pid:tid:message_id",
    "message_id": "msg_abc123",
    "start_time": 1234567890000000000,
    "end_time": 1234567891000000000,
    "text_content": "Complete accumulated text response",
    "json_content": "{\"tool_use\": {...}}",
    "total_size": 1024,
    "event_count": 15,
    "has_message_start": true,
    "sse_events": [...]
  }
}
```

## Connection Tracking

Connections are identified by `pid:tid:message_id`:
- **pid/tid**: Process and thread IDs from SSL events
- **message_id**: Extracted from `message_start` event
- **Fallback**: 10-minute time window for long streams without message IDs

## Claude API Event Flow

Standard Claude streaming sequence:
1. `message_start` - Contains message ID and metadata
2. `content_block_start` - Begins content block
3. `content_block_delta` (multiple) - Incremental content chunks
4. `content_block_stop` - Ends content block
5. `message_delta` - Contains stop_reason
6. `message_stop` - Final completion signal

## Configuration

```rust
// Default 30-second timeout
let processor = SSEProcessor::new();

// Custom timeout
let processor = SSEProcessor::new_with_timeout(60_000);
```

## Implementation Notes

- Matches Python `ssl_log_analyzer.py` behavior for compatibility
- Uses 10-minute connection windows to handle long streaming sessions
- Filters out metadata-only events (ping, message_delta without content)
- Only emits events for streams with meaningful content
- Thread-safe accumulation using `Arc<Mutex<HashMap>>`

## Testing

See `collector/src/framework/analyzers/sse_processor_tests.rs` for comprehensive test coverage including:
- SSE detection
- Event parsing
- Content accumulation
- Stream completion logic
- Connection ID generation
