// Claude Code -> DeepSeek API proxy v3
// Full support: text + tool calls + streaming
// Usage: node proxy.mjs

import http from 'node:http';
import https from 'node:https';

const PORT = process.env.PORT || 8384;
const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE || 'https://api.deepseek.com';
const DEEPSEEK_KEY = process.env.DEEPSEEK_KEY || 'sk-d61f589d103f4ce587bb1f0409fb4b58';
const TARGET_MODEL = 'deepseek-v4-pro';

const MODEL_MAP = {
  'claude-opus-4-20250514': TARGET_MODEL,
  'claude-opus-4-20250805': TARGET_MODEL,
  'claude-sonnet-4-20250514': TARGET_MODEL,
  'claude-3-5-sonnet-20241022': TARGET_MODEL,
  'claude-3-opus-20240229': TARGET_MODEL,
  'claude-3-haiku-20240307': TARGET_MODEL,
};

function mapModel(m) {
  if (MODEL_MAP[m]) return MODEL_MAP[m];
  if (m.toLowerCase().includes('claude')) return TARGET_MODEL;
  return TARGET_MODEL;
}

// --- Anthropic -> OpenAI ---

function convertAnthropicContentToOpenAI(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);

  const textParts = [];
  const toolCalls = [];
  const toolResults = [];

  for (const block of content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id || `call_${Date.now()}_${toolCalls.length}`,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
        },
      });
    } else if (block.type === 'tool_result') {
      const resultContent = typeof block.content === 'string'
        ? block.content
        : JSON.stringify(block.content);
      toolResults.push({
        tool_call_id: block.tool_use_id || '',
        content: resultContent,
      });
    }
  }

  return { textParts, toolCalls, toolResults };
}

function anthropicToOpenAI(body) {
  const messages = [];

  if (body.system) {
    let systemText = '';
    if (typeof body.system === 'string') {
      systemText = body.system;
    } else if (Array.isArray(body.system)) {
      systemText = body.system.filter(s => s.type === 'text').map(s => s.text).join('\n');
    }
    if (systemText) messages.push({ role: 'system', content: systemText });
  }

  for (const msg of body.messages || []) {
    const converted = convertAnthropicContentToOpenAI(msg.content);

    if (msg.role === 'assistant') {
      const oaiMsg = { role: 'assistant', content: null };
      if (typeof converted === 'string') {
        oaiMsg.content = converted;
      } else {
        const tp = converted.textParts || [];
        if (tp.length > 0) oaiMsg.content = tp.join('\n');
        if (converted.toolCalls && converted.toolCalls.length > 0) {
          oaiMsg.tool_calls = converted.toolCalls;
        }
      }
      messages.push(oaiMsg);
    } else if (msg.role === 'user') {
      // User messages: handle both string and structured content
      if (typeof converted === 'string') {
        messages.push({ role: 'user', content: converted });
      } else {
        const tp = converted.textParts || [];
        if (converted.toolResults && converted.toolResults.length > 0) {
          for (const tr of converted.toolResults) {
            messages.push({ role: 'tool', tool_call_id: tr.tool_call_id, content: tr.content });
          }
        }
        if (tp.length > 0 || (!converted.toolResults || converted.toolResults.length === 0)) {
          messages.push({ role: 'user', content: tp.join('\n') || '' });
        }
      }
    }
  }

  const oaiBody = {
    model: mapModel(body.model),
    messages,
    max_tokens: body.max_tokens || 4096,
    stream: !!body.stream,
  };

  if (body.temperature !== undefined) oaiBody.temperature = body.temperature;
  if (body.top_p !== undefined) oaiBody.top_p = body.top_p;
  if (body.stop_sequences) oaiBody.stop = body.stop_sequences;

  if (body.tools && Array.isArray(body.tools)) {
    oaiBody.tools = body.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
    if (body.tool_choice) {
      if (body.tool_choice.type === 'any') oaiBody.tool_choice = 'required';
      else if (body.tool_choice.type === 'auto') oaiBody.tool_choice = 'auto';
      else if (body.tool_choice.type === 'tool' && body.tool_choice.name) {
        oaiBody.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
      }
    }
  }

  return oaiBody;
}

// --- OpenAI -> Anthropic ---

function openAIResponseToAnthropic(data, model) {
  const choice = data.choices?.[0];
  const msg = choice?.message || {};
  const content = [];

  if (msg.content) {
    content.push({ type: 'text', text: msg.content });
  }

  if (msg.tool_calls && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {}
      content.push({
        type: 'tool_use',
        id: tc.id || `toolu_${Date.now()}`,
        name: tc.function?.name || '',
        input,
      });
    }
  }

  return {
    id: data.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: content.length > 0 ? content : [{ type: 'text', text: '' }],
    model,
    stop_reason: choice?.finish_reason === 'stop' ? 'end_turn'
      : (choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'max_tokens'),
    stop_sequence: null,
    usage: {
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0,
    },
  };
}

// --- Streaming Translation ---

class StreamTranslator {
  constructor(res) {
    this.res = res;
    this.buffer = '';
    this.toolCallAccum = {};
    this.started = false;
    this.finished = false;
    this.contentBlockIndex = 0;
    this.activeBlockType = null;
    this.activeToolIndex = null;
    this.nextBlockIndex = 0;
    this.messageId = '';
  }

  write(obj) {
    try { this.res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
  }

  feed(chunk) {
    this.buffer += chunk.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data: ')) continue;
      const d = t.slice(6);
      if (d === '[DONE]') { this._finish(); continue; }
      try { this._delta(JSON.parse(d)); } catch {}
    }
  }

  _start(id) {
    if (this.started) return;
    this.started = true;
    this.messageId = id || `msg_${Date.now()}`;
    this.write({
      type: 'message_start',
      message: { id: this.messageId, type: 'message', role: 'assistant', content: [], model: '', stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    });
  }

  _delta(parsed) {
    const choice = parsed.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};

    // V4 Pro: skip ALL reasoning deltas — never surface to Claude Code
    // Reasoning is internal model thinking, not user-facing content
    if (delta.reasoning_content !== undefined) {
      delete delta.reasoning_content;
      // If this delta ONLY has reasoning_content, skip entirely
      if (delta.content === undefined && delta.tool_calls === undefined) {
        return;
      }
    }

    // Text
    if (delta.content) {
      this._start(parsed.id);
      if (this.activeBlockType !== 'text') {
        this.activeBlockType = 'text';
        this.activeToolIndex = null;
        this.contentBlockIndex = this.nextBlockIndex++;
        this.write({
          type: 'content_block_start', index: this.contentBlockIndex,
          content_block: { type: 'text', text: '' },
        });
      }
      this.write({
        type: 'content_block_delta', index: this.contentBlockIndex,
        delta: { type: 'text_delta', text: delta.content },
      });
    }

    // Tool calls
    if (delta.tool_calls) {
      this._start(parsed.id);
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        if (!this.toolCallAccum[idx]) {
          this.toolCallAccum[idx] = { id: tc.id || '', name: '', args: '' };
        }
        if (tc.id) this.toolCallAccum[idx].id = tc.id;
        if (tc.function?.name) this.toolCallAccum[idx].name += tc.function.name;
        if (tc.function?.arguments) this.toolCallAccum[idx].args += tc.function.arguments;

        if (this.activeToolIndex !== idx) {
          this.activeToolIndex = idx;
          this.activeBlockType = 'tool_use';
          this.contentBlockIndex = this.nextBlockIndex++;
          this.write({
            type: 'content_block_start', index: this.contentBlockIndex,
            content_block: { type: 'tool_use', id: tc.id || '', name: tc.function?.name || '', input: {} },
          });
        } else if (tc.function?.arguments) {
          this.write({
            type: 'content_block_delta', index: this.contentBlockIndex,
            delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
          });
        }
      }
    }

    // Finish
    if (choice.finish_reason) {
      this._finish(choice.finish_reason, parsed.usage);
    }
  }

  _finish(reason, usage) {
    if (!this.started || this.finished) return;
    this.finished = true;

    const r = reason === 'stop' ? 'end_turn'
      : (reason === 'tool_calls' ? 'tool_use' : 'max_tokens');

    this.write({
      type: 'message_delta',
      delta: { stop_reason: r, stop_sequence: null },
      usage: { output_tokens: usage?.completion_tokens || 0 },
    });
    this.write({ type: 'message_stop' });
  }

  end() {
    if (this.buffer.trim().startsWith('data: ')) {
      const d = this.buffer.trim().slice(6);
      if (d !== '[DONE]') {
        try { this._delta(JSON.parse(d)); } catch {}
      }
    }
    if (this.started && !this.finished) this._finish('stop');
    this.res.end();
  }
}

// --- HTTP helpers ---

function httpReq(targetUrl, method, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const opts = {
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_KEY}` },
    };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);

    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(180000, () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function streamReq(targetUrl, body, clientRes) {
  const u = new URL(targetUrl);
  const opts = {
    hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_KEY}`, 'Content-Length': Buffer.byteLength(body) },
  };

  const req = https.request(opts, (proxyRes) => {
    if (proxyRes.statusCode !== 200) {
      const chunks = [];
      proxyRes.on('data', d => chunks.push(d));
      proxyRes.on('end', () => {
        const err = Buffer.concat(chunks).toString();
        console.error(`  DeepSeek error ${proxyRes.statusCode}: ${err.substring(0, 300)}`);
        clientRes.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
        clientRes.end(err);
      });
      return;
    }

    clientRes.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'x-robots-tag': 'none',
    });

    const t = new StreamTranslator(clientRes);
    proxyRes.on('data', d => t.feed(d));
    proxyRes.on('end', () => t.end());
    proxyRes.on('error', (err) => { console.error('  Stream error:', err.message); t.end(); });
  });

  req.on('error', (err) => {
    console.error('  Stream proxy error:', err.message);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: { type: 'api_error', message: err.message } }));
    }
  });
  req.setTimeout(300000);
  req.write(body);
  req.end();
}

// --- Router ---

async function handle(req, res) {
  const { method, url } = req;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  let body = '';
  for await (const chunk of req) { body += chunk.toString(); }

  const pathname = url.split('?')[0];
  console.log(`[${new Date().toISOString()}] ${method} ${pathname}`);

  // Models
  if (method === 'GET' && pathname === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: Object.keys(MODEL_MAP).map(id => ({ id, object: 'model', created: 1700000000, owned_by: 'anthropic' })),
    }));
    return;
  }

  // Messages
  if (method === 'POST' && pathname === '/v1/messages') {
    try {
      const anthro = JSON.parse(body);
      const oai = anthropicToOpenAI(anthro);
      const hasTools = oai.tools?.length || 0;
      console.log(`  Model: ${anthro.model} -> ${oai.model}, Stream: ${!!anthro.stream}, Tools: ${hasTools}`);

      if (anthro.stream) {
        await streamReq(`${DEEPSEEK_BASE}/v1/chat/completions`, JSON.stringify(oai), res);
      } else {
        const r = await httpReq(`${DEEPSEEK_BASE}/v1/chat/completions`, 'POST', JSON.stringify(oai));
        if (r.status !== 200) {
          console.error(`  DeepSeek error: ${r.status} ${r.body.substring(0, 300)}`);
          res.writeHead(r.status, { 'Content-Type': 'application/json' });
          res.end(r.body);
          return;
        }
        const translated = openAIResponseToAnthropic(JSON.parse(r.body), anthro.model);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(translated));
      }
    } catch (err) {
      console.error('  Error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'api_error', message: err.message } }));
    }
    return;
  }

  // Count tokens
  if (method === 'POST' && pathname === '/v1/messages/count_tokens') {
    try {
      const b = JSON.parse(body);
      let chars = 0;
      function countContent(c) {
        if (typeof c === 'string') return c.length;
        if (Array.isArray(c)) {
          let n = 0;
          for (const block of c) {
            if (block.type === 'text') n += (block.text || '').length;
            else if (block.type === 'tool_use') n += JSON.stringify(block.input || {}).length + (block.name || '').length + 10;
            else if (block.type === 'tool_result') n += (typeof block.content === 'string' ? block.content.length : JSON.stringify(block.content).length) + 20;
          }
          return n;
        }
        return String(c).length;
      }
      if (b.system) {
        if (typeof b.system === 'string') chars += b.system.length;
        else if (Array.isArray(b.system)) {
          for (const s of b.system) if (s.type === 'text') chars += (s.text || '').length;
        }
      }
      for (const msg of b.messages || []) {
        const c = convertAnthropicContentToOpenAI(msg.content);
        chars += (c.textParts || []).join('').length;
        if (c.toolCalls) {
          for (const tc of c.toolCalls) chars += JSON.stringify(tc).length + 10;
        }
        if (c.toolResults) {
          for (const tr of c.toolResults) chars += (tr.content || '').length + 20;
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: Math.ceil(chars / 3.5) }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err.message } }));
    }
    return;
  }

  // Health check
  if (method === 'HEAD' && pathname === '/') { res.writeHead(200); res.end(); return; }

  // Pass-through
  if (pathname && pathname.startsWith('/v1/')) {
    try {
      const r = await httpReq(`${DEEPSEEK_BASE}${url}`, method, body || undefined);
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(r.body);
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err.message } }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

// --- Start ---

http.createServer(handle).listen(PORT, () => {
  console.log(`\nClaude Code -> DeepSeek Proxy v3`);
  console.log(`  http://127.0.0.1:${PORT}`);
  console.log(`  -> ${DEEPSEEK_BASE}`);
  console.log(`\n  $env:ANTHROPIC_BASE_URL="http://127.0.0.1:${PORT}"`);
  console.log(`  $env:ANTHROPIC_API_KEY="any-value"`);
  console.log();
});
