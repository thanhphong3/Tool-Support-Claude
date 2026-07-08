import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import * as fs from 'fs';
import * as path from 'path';
import { resolveEndpoints } from './utils';

class StreamParser {
    private inThinkMode = false;
    private buffer = '';
    private readonly endTags = ['</think>', '</thinking>', '</thought>', '</reasoning>'];
    private readonly startTags = ['<think>', '<thinking>', '<thought>', '<reasoning>'];

    public get isThinking(): boolean {
        return this.inThinkMode;
    }
    
    public feed(chunk: string): { thinking: string; text: string } {
        let thinking = '';
        let text = '';
        
        let fullText = this.buffer + chunk;
        this.buffer = '';
        
        while (fullText.length > 0) {
            if (this.inThinkMode) {
                let nextEndIdx = -1;
                let matchedTag = '';
                
                for (const tag of this.endTags) {
                    const idx = fullText.indexOf(tag);
                    if (idx !== -1) {
                        if (nextEndIdx === -1 || idx < nextEndIdx) {
                            nextEndIdx = idx;
                            matchedTag = tag;
                        } else if (idx === nextEndIdx && tag.length > matchedTag.length) {
                            matchedTag = tag; // prefer longer tag if starting at same position
                        }
                    }
                }
                
                if (nextEndIdx !== -1) {
                    thinking += fullText.substring(0, nextEndIdx);
                    this.inThinkMode = false;
                    fullText = fullText.substring(nextEndIdx + matchedTag.length);
                } else {
                    let partialMatchLength = 0;
                    let maxSuffixLen = 0;
                    for (const tag of this.endTags) {
                        maxSuffixLen = Math.max(maxSuffixLen, tag.length);
                    }
                    maxSuffixLen = Math.min(fullText.length, maxSuffixLen);
                    
                    for (let i = maxSuffixLen; i > 0; i--) {
                        const suffix = fullText.substring(fullText.length - i);
                        let matched = false;
                        for (const tag of this.endTags) {
                            if (tag.startsWith(suffix)) {
                                matched = true;
                                break;
                            }
                        }
                        if (matched) {
                            partialMatchLength = i;
                            break;
                        }
                    }
                    if (partialMatchLength > 0) {
                        thinking += fullText.substring(0, fullText.length - partialMatchLength);
                        this.buffer = fullText.substring(fullText.length - partialMatchLength);
                        fullText = '';
                    } else {
                        thinking += fullText;
                        fullText = '';
                    }
                }
            } else {
                let nextStartIdx = -1;
                let matchedTag = '';
                
                for (const tag of this.startTags) {
                    const idx = fullText.indexOf(tag);
                    if (idx !== -1) {
                        if (nextStartIdx === -1 || idx < nextStartIdx) {
                            nextStartIdx = idx;
                            matchedTag = tag;
                        } else if (idx === nextStartIdx && tag.length > matchedTag.length) {
                            matchedTag = tag; // prefer longer tag if starting at same position
                        }
                    }
                }
                
                if (nextStartIdx !== -1) {
                    text += fullText.substring(0, nextStartIdx);
                    this.inThinkMode = true;
                    fullText = fullText.substring(nextStartIdx + matchedTag.length);
                } else {
                    let partialMatchLength = 0;
                    let maxSuffixLen = 0;
                    for (const tag of this.startTags) {
                        maxSuffixLen = Math.max(maxSuffixLen, tag.length);
                    }
                    maxSuffixLen = Math.min(fullText.length, maxSuffixLen);
                    
                    for (let i = maxSuffixLen; i > 0; i--) {
                        const suffix = fullText.substring(fullText.length - i);
                        let matched = false;
                        for (const tag of this.startTags) {
                            if (tag.startsWith(suffix)) {
                                matched = true;
                                break;
                            }
                        }
                        if (matched) {
                            partialMatchLength = i;
                            break;
                        }
                    }
                    if (partialMatchLength > 0) {
                        text += fullText.substring(0, fullText.length - partialMatchLength);
                        this.buffer = fullText.substring(fullText.length - partialMatchLength);
                        fullText = '';
                    } else {
                        text += fullText;
                        fullText = '';
                    }
                }
            }
        }
        
        return { thinking, text };
    }
    
    public flush(): { thinking: string; text: string } {
        const remaining = this.buffer;
        this.buffer = '';
        if (remaining) {
            if (this.inThinkMode) {
                return { thinking: remaining, text: '' };
            } else {
                return { thinking: '', text: remaining };
            }
        }
        return { thinking: '', text: '' };
    }
}

interface AnthropicMessageContent {
    type: 'text' | 'image' | 'tool_use' | 'tool_result';
    text?: string;
    source?: {
        type: 'base64';
        media_type: string;
        data: string;
    };
    id?: string;
    name?: string;
    input?: any;
    tool_use_id?: string;
    content?: string | any[];
    is_error?: boolean;
}

interface AnthropicMessage {
    role: 'user' | 'assistant' | 'tool';
    content: string | AnthropicMessageContent[];
}

interface AnthropicTool {
    name: string;
    description?: string;
    input_schema: any;
}

interface AnthropicToolChoice {
    type: 'auto' | 'any' | 'tool';
    name?: string;
}

interface AnthropicRequest {
    model: string;
    messages: AnthropicMessage[];
    system?: string;
    max_tokens?: number;
    temperature?: number;
    stream?: boolean;
    tools?: AnthropicTool[];
    tool_choice?: AnthropicToolChoice;
}

export class ProxyServer {
    private server: http.Server | null = null;
    private activePort: number = 20128;
    private apiEndpoint: string = '';
    private apiKey: string = '';
    private modelMapping: Record<string, string> = {};
    private logStream: fs.WriteStream | null = null;
    private cachedEndpoints: { chatCompletionsUrl: string; modelsUrl: string } | null = null;
    private requestTimeoutMs: number = 900000; // default 15 minutes
    // Track active streaming requests to prevent duplicate concurrent responses
    private activeRequests: Map<string, { timestamp: number; abortController: AbortController }> = new Map();

    private httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
    private httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });

    constructor() {}

    /**
     * Start the proxy HTTP server.
     */
    public start(
        port: number,
        apiEndpoint: string,
        apiKey: string,
        modelMapping: Record<string, string>,
        requestTimeoutSeconds?: number
    ): Promise<number> {
        this.activePort = port;
        this.apiEndpoint = apiEndpoint;
        this.apiKey = apiKey;
        this.modelMapping = modelMapping;
        this.cachedEndpoints = resolveEndpoints(apiEndpoint);
        if (requestTimeoutSeconds !== undefined && requestTimeoutSeconds > 0) {
            this.requestTimeoutMs = requestTimeoutSeconds * 1000;
        } else {
            this.requestTimeoutMs = 900000; // default 15 minutes
        }

        return new Promise((resolve, reject) => {
            if (this.server) {
                resolve(this.activePort);
                return;
            }

            this.server = http.createServer((req, res) => {
                // Disable Nagle's algorithm to send response without delay
                if (req.socket) {
                    req.socket.setNoDelay(true);
                }

                // Enable CORS
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

                if (req.method === 'OPTIONS') {
                    res.writeHead(200);
                    res.end();
                    return;
                }

                this.logToFile(`Incoming Request: ${req.method} ${req.url}`);

                const fullUrl = req.url || '';
                const urlPath = fullUrl.split('?')[0]; // strip query parameters

                if (req.method === 'HEAD') {
                    // Health checks
                    if (urlPath === '/v1' || urlPath === '/v1/' || urlPath === '/') {
                        res.writeHead(200);
                        res.end();
                        return;
                    }
                }

                // Handle routes robustly (supporting /v1/messages, /v1/v1/messages, /messages, etc.)
                if (req.method === 'POST') {
                    if (urlPath === '/v1/messages' || urlPath === '/v1/v1/messages' || urlPath === '/messages') {
                        this.handleMessagesRequest(req, res);
                        return;
                    }
                } else if (req.method === 'GET') {
                    if (urlPath === '/v1/models' || urlPath === '/v1/v1/models' || urlPath === '/models') {
                        this.handleListModelsRequest(req, res);
                        return;
                    } else if (urlPath.startsWith('/v1/models/') || urlPath.startsWith('/v1/v1/models/') || urlPath.startsWith('/models/')) {
                        this.handleRetrieveModelRequest(req, res);
                        return;
                    }
                }

                this.logToFile(`Route not matched (404): ${req.method} ${req.url}`);
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Not Found' } }));
            });

            this.server.on('error', (err: any) => {
                reject(err);
            });

            this.server.listen(this.activePort, () => {
                resolve(this.activePort);
            });
        });
    }

    /**
     * Stop the proxy server.
     */
    public stop(): Promise<void> {
        return new Promise((resolve) => {
            if (this.logStream) {
                this.logStream.end();
                this.logStream = null;
            }
            this.cachedEndpoints = null;
            if (!this.server) {
                resolve();
                return;
            }
            this.server.close(() => {
                this.server = null;
                resolve();
            });
        });
    }

    /**
     * Check if the server is currently running.
     */
    public isRunning(): boolean {
        return this.server !== null;
    }

    private logToFile(message: string) {
        if (!this.logStream) {
            try {
                const logPath = path.join(__dirname, 'proxy.log');
                this.logStream = fs.createWriteStream(logPath, { flags: 'a', encoding: 'utf8' });
                this.logStream.on('error', () => {
                    this.logStream = null;
                });
            } catch (e) {
                return;
            }
        }
        this.logStream.write(`[${new Date().toISOString()}] ${message}\n`);
    }

    /**
     * Handle GET /v1/models request.
     */
    private handleListModelsRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        this.logToFile('Handling GET /v1/models');
        
        const modelsList = [
            {
                type: 'model',
                id: 'claude-3-5-sonnet-20241022',
                display_name: 'Claude 3.5 Sonnet',
                created_at: '2024-10-22T00:00:00Z'
            },
            {
                type: 'model',
                id: 'claude-3-5-haiku-20241022',
                display_name: 'Claude 3.5 Haiku',
                created_at: '2024-10-22T00:00:00Z'
            },
            {
                type: 'model',
                id: 'claude-3-opus-20240229',
                display_name: 'Claude 3 Opus',
                created_at: '2024-02-29T00:00:00Z'
            }
        ];

        // Dynamically add mapped target models to the list if they are not already present
        if (this.modelMapping) {
            for (const targetModel of Object.values(this.modelMapping)) {
                if (targetModel && !modelsList.some(m => m.id === targetModel)) {
                    modelsList.push({
                        type: 'model',
                        id: targetModel,
                        display_name: targetModel,
                        created_at: new Date().toISOString()
                    });
                }
            }
        }

        const responseData = {
            data: modelsList,
            has_more: false,
            first_id: modelsList[0]?.id || '',
            last_id: modelsList[modelsList.length - 1]?.id || ''
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseData));
    }

    /**
     * Handle GET /v1/models/:model_id request.
     */
    private handleRetrieveModelRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        const fullUrl = req.url || '';
        const urlPath = fullUrl.split('?')[0];
        const urlParts = urlPath.split('/') || [];
        const modelId = urlParts[urlParts.length - 1];
        this.logToFile(`Handling GET /v1/models/${modelId}`);

        const knownModels: Record<string, { type: string; id: string; display_name: string; created_at: string }> = {
            'claude-3-5-sonnet-20241022': {
                type: 'model',
                id: 'claude-3-5-sonnet-20241022',
                display_name: 'Claude 3.5 Sonnet',
                created_at: '2024-10-22T00:00:00Z'
            },
            'claude-3-5-haiku-20241022': {
                type: 'model',
                id: 'claude-3-5-haiku-20241022',
                display_name: 'Claude 3.5 Haiku',
                created_at: '2024-10-22T00:00:00Z'
            },
            'claude-3-opus-20240229': {
                type: 'model',
                id: 'claude-3-opus-20240229',
                display_name: 'Claude 3 Opus',
                created_at: '2024-02-29T00:00:00Z'
            }
        };

        const modelInfo = knownModels[modelId];

        if (modelInfo) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(modelInfo));
        } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                type: 'model',
                id: modelId,
                display_name: modelId,
                created_at: new Date().toISOString()
            }));
        }
    }

    /**
     * Read the full request body and forward it to the target AI API.
     */
    private handleMessagesRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        const chunks: Buffer[] = [];
        let totalLength = 0;
        let requestDestroyed = false; // guard against 'end' firing after destroy()
        const MAX_BODY_SIZE = 50 * 1024 * 1024; // 50MB safety limit

        req.on('data', (chunk: Buffer) => {
            if (requestDestroyed) { return; }
            totalLength += chunk.length;
            if (totalLength > MAX_BODY_SIZE) {
                requestDestroyed = true;
                req.destroy();
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: { type: 'api_error', message: 'Request body too large (max 50MB)' }
                }));
                return;
            }
            chunks.push(chunk);
        });

        req.on('end', async () => {
            if (requestDestroyed) { return; } // skip if we already responded with 413
            try {
                const body = Buffer.concat(chunks, totalLength).toString('utf8');
                const anthropicReq: AnthropicRequest = JSON.parse(body);
                this.logToFile(`Incoming request model: ${anthropicReq.model}`);
                // this.logToFile(`Incoming messages: ${JSON.stringify(anthropicReq.messages, null, 2)}`); // Disabled for performance
                console.log(`[Proxy] Incoming request for model: ${anthropicReq.model}`);

                const currentAbortController = new AbortController();
                let clientDisconnected = false;

                // --- Request-level deduplication ---
                // Claude Code SDK may send multiple parallel requests (e.g. title generation and chat completion)
                // or retry the exact same prompt if a connection times out.
                // We generate a unique deduplication key based on the model, message count, and last message content
                // to block actual duplicate retries while allowing legitimate parallel requests.
                const lastMsg = anthropicReq.messages?.[anthropicReq.messages.length - 1];
                const lastContent = typeof lastMsg?.content === 'string'
                    ? lastMsg.content
                    : JSON.stringify(lastMsg?.content || '');
                const messageCount = anthropicReq.messages?.length || 0;
                const dedupKey = `${anthropicReq.model}::${messageCount}::${lastContent.substring(0, 500)}`;

                const activeReq = this.activeRequests.get(dedupKey);
                const now = Date.now();
                if (activeReq && (now - activeReq.timestamp) < 120000) {
                    // Another request with the exact same content is already in-flight (within 2 min)
                    this.logToFile(`[DEDUP] Rejecting duplicate request for key ${dedupKey.substring(0, 100)}... — active request in-flight since ${now - activeReq.timestamp}ms ago`);
                    res.writeHead(529, { 'Content-Type': 'application/json', 'retry-after': '5' });
                    res.end(JSON.stringify({
                        type: 'error',
                        error: {
                            type: 'overloaded_error',
                            message: 'Another request for this model is already in progress. Please retry.'
                        }
                    }));
                    return;
                }

                // Register this request as the active one
                this.activeRequests.set(dedupKey, {
                    timestamp: now,
                    abortController: currentAbortController
                });

                // Cleanup helper — remove from active map when done
                const cleanupActiveRequest = () => {
                    const current = this.activeRequests.get(dedupKey);
                    if (current && current.abortController === currentAbortController) {
                        this.activeRequests.delete(dedupKey);
                    }
                };

                // Detect actual TCP client disconnect (e.g. Claude Code SDK cancels before retry)
                // IMPORTANT: Must listen on `res` (ServerResponse), NOT on `req` (IncomingMessage).
                // req 'close' fires immediately after 'end' (body fully read) — NOT on disconnect.
                // res 'close' fires when the underlying socket is destroyed/closed by the client.
                res.on('close', () => {
                    if (!res.writableFinished) {
                        clientDisconnected = true;
                        this.logToFile(`[ABORT] Client disconnected for key ${dedupKey.substring(0, 100)}..., aborting upstream fetch`);
                        currentAbortController.abort();
                        cleanupActiveRequest();
                    }
                });

                // 1. Translate Anthropic Request to target API format (OpenAI Chat Completions)
                const mappedModel = this.modelMapping[anthropicReq.model] || anthropicReq.model;
                this.logToFile(`Mapped model: ${anthropicReq.model} -> ${mappedModel}`);
                console.log(`[Proxy] Mapped model: ${anthropicReq.model} -> ${mappedModel}`);
                const requestBody = this.translateRequest(anthropicReq, mappedModel);

                // 2. Setup external request options
                const chatCompletionsUrl = this.cachedEndpoints!.chatCompletionsUrl;
                const parsedUrl = new URL(chatCompletionsUrl);
                const isHttps = parsedUrl.protocol === 'https:';
                const reqModule = isHttps ? https : http;
                const agent = isHttps ? this.httpsAgent : this.httpAgent;

                const headers: Record<string, string> = {
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                };
                if (this.apiKey) {
                    headers['Authorization'] = `Bearer ${this.apiKey}`;
                }

                await new Promise<void>((resolvePromise, rejectPromise) => {
                    const requestBodyStr = JSON.stringify(requestBody);

                    const upstreamReq = reqModule.request(
                        chatCompletionsUrl,
                        {
                            method: 'POST',
                            headers,
                            agent,
                            signal: currentAbortController.signal,
                        },
                        async (upstreamRes) => {
                            try {
                                const status = upstreamRes.statusCode || 500;
                                this.logToFile(`Remote response status: ${status}`);
                                console.log(`[Proxy] Remote response status: ${status}`);

                                if (status < 200 || status >= 300) {
                                    cleanupActiveRequest();
                                    
                                    let errorText = '';
                                    const errorDecoder = new TextDecoder();
                                    for await (const chunk of upstreamRes) {
                                        errorText += errorDecoder.decode(chunk, { stream: true });
                                    }
                                    errorText += errorDecoder.decode();

                                    this.logToFile(`Remote error: ${errorText}`);
                                    console.error(`[Proxy] Remote error: ${errorText}`);
                                    if (!res.writableEnded) {
                                        res.writeHead(status, { 'Content-Type': 'application/json' });
                                        res.end(JSON.stringify({
                                            error: {
                                                type: 'api_error',
                                                message: `Internal Provider error (Status ${status}): ${errorText}`
                                            }
                                        }));
                                    }
                                    resolvePromise();
                                    return;
                                }

                                if (clientDisconnected) {
                                    cleanupActiveRequest();
                                    this.logToFile(`[ABORT] Skipping response handling — client already disconnected`);
                                    resolvePromise();
                                    return;
                                }

                                if (anthropicReq.stream) {
                                    this.handleStreamResponse(upstreamRes, res, anthropicReq.model)
                                        .then(() => {
                                            cleanupActiveRequest();
                                            resolvePromise();
                                        })
                                        .catch((err) => {
                                            cleanupActiveRequest();
                                            rejectPromise(err);
                                        });
                                } else {
                                    this.handleStandardResponse(upstreamRes, res, anthropicReq.model)
                                        .then(() => {
                                            cleanupActiveRequest();
                                            resolvePromise();
                                        })
                                        .catch((err) => {
                                            cleanupActiveRequest();
                                            rejectPromise(err);
                                        });
                                }
                            } catch (err) {
                                rejectPromise(err);
                            }
                        }
                    );

                    upstreamReq.on('error', (err: any) => {
                        cleanupActiveRequest();
                        rejectPromise(err);
                    });

                    // Disable Nagle's algorithm for the upstream request to reduce TTFB
                    upstreamReq.on('socket', (socket) => {
                        socket.setNoDelay(true);
                    });

                    // Set upstream request timeout to prevent infinite hangs
                    upstreamReq.setTimeout(this.requestTimeoutMs, () => {
                        const timeoutSec = Math.round(this.requestTimeoutMs / 1000);
                        this.logToFile(`[TIMEOUT] Upstream request timed out after ${timeoutSec}s`);
                        upstreamReq.destroy(new Error(`Upstream request timed out after ${timeoutSec}s (Gateway Timeout)`));
                    });

                    upstreamReq.write(requestBodyStr);
                    upstreamReq.end();
                });
            } catch (err: any) {
                // If the error is from aborting (client disconnect), silently ignore
                if (err.name === 'AbortError') {
                    this.logToFile(`[ABORT] Request aborted — client disconnected`);
                    return;
                }
                // Only write error if client socket is still writable
                if (!res.writableEnded) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: {
                            type: 'api_error',
                            message: `Proxy failed to process request: ${err.message}`
                        }
                    }));
                }
            }
        });
    }

    /**
     * Map Anthropic messages and parameters to OpenAI-compatible structure.
     */
    private translateRequest(anthropicReq: AnthropicRequest, model: string) {
        const messages: any[] = [];

        // Prepend system prompt if present (flattens array content blocks to a string if needed)
        if (anthropicReq.system) {
            let systemContent = '';
            if (Array.isArray(anthropicReq.system)) {
                systemContent = anthropicReq.system
                    .map((block: any) => {
                        if (typeof block === 'string') { return block; }
                        if (block && block.type === 'text') { return block.text || ''; }
                        return JSON.stringify(block);
                    })
                    .join('\n');
            } else {
                systemContent = anthropicReq.system;
            }
            messages.push({
                role: 'system',
                content: systemContent
            });
        }

        // Translate user/assistant messages
        for (const msg of anthropicReq.messages) {
            let content: any = msg.content;
            
            if (Array.isArray(msg.content)) {
                const textBlocks = msg.content.filter((block: any) => block.type === 'text');
                const textContent = textBlocks.map((block: any) => block.text).join('\n');

                // Check if this is an assistant message
                if (msg.role === 'assistant') {
                    const thinkingBlocks = msg.content.filter((block: any) => block.type === 'thinking');
                    const thinkingContent = thinkingBlocks.map((block: any) => block.thinking).join('\n');
                    const toolUseBlocks = msg.content.filter((block: any) => block.type === 'tool_use');
                    
                    const assistantMsg: any = {
                        role: 'assistant',
                        content: textContent || ''
                    };
                    if (thinkingContent) {
                        assistantMsg.reasoning_content = thinkingContent;
                    }
                    if (toolUseBlocks.length > 0) {
                        assistantMsg.tool_calls = toolUseBlocks.map((block: any) => ({
                            id: block.id,
                            type: 'function',
                            function: {
                                name: block.name,
                                arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input)
                            }
                        }));
                    }
                    messages.push(assistantMsg);
                    continue;
                }
                
                // Check if this is a user message with tool results
                if (msg.role === 'user') {
                    const toolResultBlocks = msg.content.filter((block: any) => block.type === 'tool_result');
                    const otherBlocks = msg.content.filter((block: any) => block.type !== 'tool_result');
                    
                    // First, push any tool results as separate tool messages
                    for (const block of toolResultBlocks) {
                        let resultText = '';
                        if (typeof block.content === 'string') {
                            resultText = block.content;
                        } else if (Array.isArray(block.content)) {
                            resultText = block.content
                                .map((c: any) => {
                                    if (c.type === 'text') { return c.text; }
                                    return JSON.stringify(c);
                                })
                                .join('\n');
                        } else {
                            resultText = JSON.stringify(block.content);
                        }
                        
                        messages.push({
                            role: 'tool',
                            tool_call_id: block.tool_use_id,
                            content: resultText
                        });
                    }
                    
                    // Then, if there are other content blocks, push them as a user message
                    if (otherBlocks.length > 0) {
                        const parsedContent = otherBlocks.map((block: any) => {
                            if (block.type === 'text') {
                                return { type: 'text', text: block.text };
                            } else if (block.type === 'image' && block.source) {
                                return {
                                    type: 'image_url',
                                    image_url: {
                                        url: `data:${block.source.media_type};base64,${block.source.data}`
                                    }
                                };
                            }
                            return block;
                        });
                        
                        messages.push({
                            role: 'user',
                            content: parsedContent.length === 1 && parsedContent[0].type === 'text' ? parsedContent[0].text : parsedContent
                        });
                    }
                    continue;
                }

                // Default array translation
                content = msg.content.map((block: any) => {
                    if (block.type === 'text') {
                        return { type: 'text', text: block.text };
                    } else if (block.type === 'image' && block.source) {
                        return {
                            type: 'image_url',
                            image_url: {
                                url: `data:${block.source.media_type};base64,${block.source.data}`
                            }
                        };
                    }
                    return block;
                });
            }

            messages.push({
                role: msg.role,
                content: content
            });
        }

        const openAIReq: any = {
            model: model,
            messages: messages,
            max_tokens: anthropicReq.max_tokens,
            temperature: anthropicReq.temperature ?? 1.0,
            stream: anthropicReq.stream ?? false
        };

        if (openAIReq.stream) {
            openAIReq.stream_options = { include_usage: true };
        }

        // Translate tools
        if (anthropicReq.tools && anthropicReq.tools.length > 0) {
            openAIReq.tools = anthropicReq.tools.map(tool => ({
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.input_schema
                }
            }));
        }

        // Translate tool_choice
        if (anthropicReq.tool_choice) {
            if (anthropicReq.tool_choice.type === 'auto') {
                openAIReq.tool_choice = 'auto';
            } else if (anthropicReq.tool_choice.type === 'any') {
                openAIReq.tool_choice = 'required';
            } else if (anthropicReq.tool_choice.type === 'tool' && anthropicReq.tool_choice.name) {
                openAIReq.tool_choice = {
                    type: 'function',
                    function: {
                        name: anthropicReq.tool_choice.name
                    }
                };
            }
        }

        return openAIReq;
    }

    /**
     * Handle non-streaming response by converting the complete OpenAI payload to Anthropic format.
     */
    private async handleStandardResponse(upstreamRes: http.IncomingMessage, res: http.ServerResponse, requestedModel: string) {
        let responseBody = '';
        const decoder = new TextDecoder();
        for await (const chunk of upstreamRes) {
            responseBody += decoder.decode(chunk, { stream: true });
        }
        responseBody += decoder.decode();

        const openAIResp = JSON.parse(responseBody) as any;
        
        const message = openAIResp.choices?.[0]?.message;
        const textContent = message?.content || '';
        const toolCalls = message?.tool_calls || [];
        const reasoning = message?.reasoning_content || message?.reasoning || '';
        
        const content: any[] = [];
        
        // 1. Include thinking/reasoning if present
        if (reasoning) {
            const dummySig = `sig_${Math.random().toString(36).substring(7)}_${Date.now()}`;
            content.push({
                type: 'thinking',
                thinking: reasoning,
                signature: dummySig
            });
        }
        
        // 2. Include text content if present
        if (textContent) {
            content.push({
                type: 'text',
                text: textContent
            });
        }
        
        // 3. Include tool calls if present
        for (const tc of toolCalls) {
            let input = {};
            try {
                input = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
            } catch (e) {
                input = { raw_arguments: tc.function.arguments };
            }
            content.push({
                type: 'tool_use',
                id: tc.id,
                name: tc.function.name,
                input: input
            });
        }

        const inputTokens = openAIResp.usage?.prompt_tokens || 0;
        const outputTokens = openAIResp.usage?.completion_tokens || 0;

        // Map stop reason
        const finishReason = openAIResp.choices?.[0]?.finish_reason;
        let stopReason = 'end_turn';
        if (finishReason === 'tool_calls' || toolCalls.length > 0) {
            stopReason = 'tool_use';
        } else if (finishReason === 'length') {
            stopReason = 'max_tokens';
        }

        const anthropicResponse = {
            id: `msg_${openAIResp.id || Math.random().toString(36).substring(7)}`,
            type: 'message',
            role: 'assistant',
            model: requestedModel,
            content: content,
            stop_reason: stopReason,
            stop_sequence: null,
            usage: {
                input_tokens: inputTokens,
                output_tokens: outputTokens
            }
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(anthropicResponse));
    }

    /**
     * Translate the OpenAI SSE stream to Anthropic SSE format in real-time.
     */
    private async handleStreamResponse(upstreamRes: http.IncomingMessage, res: http.ServerResponse, requestedModel: string) {
        // Disable socket delay to allow real-time flushing of response data
        res.socket?.setNoDelay(true);

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });

        // Track client disconnect so we can stop reading upstream
        let streamClientDisconnected = false;
        res.on('close', () => {
            streamClientDisconnected = true;
        });

        let sseOutputBuffer = '';
        const writeSSEEventLocal = (event: string, data: any) => {
            if (res.writableEnded || res.destroyed) return;
            sseOutputBuffer += `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        };
        const flushSSEBuffer = () => {
            if (sseOutputBuffer.length > 0 && !res.writableEnded && !res.destroyed) {
                res.write(sseOutputBuffer);
                sseOutputBuffer = '';
            }
        };

        // Setup keep-alive ping interval to prevent client timeouts (e.g. Claude Code CLI has a default request/idle timeout)
        const keepAliveInterval = setInterval(() => {
            if (!streamClientDisconnected && !res.writableEnded && !res.destroyed) {
                // Send an empty SSE comment line to keep the connection alive at the TCP/HTTP level
                res.write(':\n\n');
                flushSSEBuffer(); // Flush any pending buffer if any
            }
        }, 3000);

        // Write Anthropic's message startup events
        const messageId = `msg_stream_${Math.random().toString(36).substring(7)}`;
        writeSSEEventLocal('message_start', {
            type: 'message_start',
            message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                model: requestedModel,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 }
            }
        });

        const decoder = new TextDecoder();
        let buffer = '';
        
        let hasStartedThinkingBlock = false;
        let thinkingBlockClosed = false;
        let hasStartedTextBlock = false;
        let thinkingBlockIndex = -1;
        let textBlockIndex = -1;
        let nextAnthropicIndex = 0;
        
        // Parsers and accumulators to handle incremental/cumulative streams and strip <think> tags
        const parser = new StreamParser();
        let rawReasoningAccumulator = '';
        let rawContentAccumulator = '';
        let hasProviderReasoning = false; // Flag to prioritize provider's native reasoning_content stream over think tags in content
        
        let hasToolCalls = false;
        const toolCallIndexMap = new Map<number, number>();
        let streamFinishReason = '';
        let streamUsage: any = null;

        try {
            for await (const value of upstreamRes) {
                // Stop reading upstream if client already disconnected
                if (streamClientDisconnected) {
                    this.logToFile(`[ABORT] Stream client disconnected for model ${requestedModel}, stopping upstream read`);
                    upstreamRes.destroy();
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                
                let startIndex = 0;
                let eolIndex;
                while ((eolIndex = buffer.indexOf('\n', startIndex)) !== -1) {
                    let line = buffer.substring(startIndex, eolIndex);
                    startIndex = eolIndex + 1;
                    if (line.endsWith('\r')) {
                        line = line.slice(0, -1);
                    }
                    const trimmed = line.trim();
                    if (!trimmed) {
                        continue;
                    }
                    if (trimmed.startsWith('data:')) {
                        const dataContent = trimmed.substring(5).trim();
                        if (dataContent === '[DONE]') {
                            continue;
                        }

                        try {
                            const parsed = JSON.parse(dataContent);
                            
                            // Capture finish reason and usage if present
                            if (parsed.choices?.[0]?.finish_reason) {
                                streamFinishReason = parsed.choices[0].finish_reason;
                            }
                            if (parsed.usage) {
                                streamUsage = parsed.usage;
                            }

                            const delta = parsed.choices?.[0]?.delta;
                            if (!delta) {
                                continue;
                            }
                            
                            // 1. Process reasoning/thinking stream (reasoning_content)
                            const reasoning = delta?.reasoning_content || delta?.reasoning;
                            let newThinking = '';
                            if (reasoning !== undefined && reasoning !== null && reasoning !== '') {
                                hasProviderReasoning = true; // Mark that provider is natively streaming reasoning_content
                                if (rawReasoningAccumulator && reasoning.startsWith(rawReasoningAccumulator) && reasoning.length > rawReasoningAccumulator.length) {
                                    newThinking = reasoning.substring(rawReasoningAccumulator.length);
                                    rawReasoningAccumulator = reasoning;
                                } else if (rawReasoningAccumulator && reasoning === rawReasoningAccumulator) {
                                    // no change
                                } else {
                                    newThinking = reasoning;
                                    rawReasoningAccumulator += reasoning;
                                }
                            }
                            
                            // 2. Process content stream (split standard text and <think> tags in real-time)
                            const content = delta?.content;
                            let incrementalContent = '';
                            if (content !== undefined && content !== null && content !== '') {
                                if (rawContentAccumulator && content.startsWith(rawContentAccumulator) && content.length > rawContentAccumulator.length) {
                                    incrementalContent = content.substring(rawContentAccumulator.length);
                                    rawContentAccumulator = content;
                                } else if (rawContentAccumulator && content === rawContentAccumulator) {
                                    incrementalContent = '';
                                } else {
                                    incrementalContent = content;
                                    rawContentAccumulator += content;
                                }
                            }
                            
                            let newText = '';
                            if (incrementalContent) {
                                const parsedResult = parser.feed(incrementalContent);
                                
                                // Accumulate thinking parsed from content ONLY if the provider is not natively sending reasoning_content
                                if (parsedResult.thinking && !hasProviderReasoning) {
                                    newThinking += parsedResult.thinking;
                                }
                                
                                if (parsedResult.text) {
                                    newText += parsedResult.text;
                                }
                            }

                            // 3. Determine if we should close the thinking block
                            const shouldCloseThinking = hasProviderReasoning 
                                ? (!reasoning && content) 
                                : (!parser.isThinking && hasStartedThinkingBlock);

                            if (hasStartedThinkingBlock && !thinkingBlockClosed && shouldCloseThinking) {
                                const dummySig = `sig_${Math.random().toString(36).substring(7)}_${Date.now()}`;
                                writeSSEEventLocal('content_block_delta', {
                                    type: 'content_block_delta',
                                    index: thinkingBlockIndex,
                                    delta: { type: 'signature_delta', signature: dummySig }
                                });
                                writeSSEEventLocal('content_block_stop', {
                                    type: 'content_block_stop',
                                    index: thinkingBlockIndex
                                });
                                hasStartedThinkingBlock = false;
                                thinkingBlockClosed = true;
                            }

                            // 4. Stream thinking updates
                            if (newThinking && !thinkingBlockClosed) {
                                if (!hasStartedThinkingBlock) {
                                    thinkingBlockIndex = nextAnthropicIndex++;
                                    writeSSEEventLocal('content_block_start', {
                                        type: 'content_block_start',
                                        index: thinkingBlockIndex,
                                        content_block: { type: 'thinking', thinking: '', signature: '' }
                                    });
                                    hasStartedThinkingBlock = true;
                                }
                                writeSSEEventLocal('content_block_delta', {
                                    type: 'content_block_delta',
                                    index: thinkingBlockIndex,
                                    delta: { type: 'thinking_delta', thinking: newThinking }
                                });
                            }

                            // 5. Stream text updates (only if thinking is closed or was never started)
                            if (newText && (thinkingBlockClosed || !hasStartedThinkingBlock)) {
                                if (!hasStartedTextBlock) {
                                    textBlockIndex = nextAnthropicIndex++;
                                    writeSSEEventLocal('content_block_start', {
                                        type: 'content_block_start',
                                        index: textBlockIndex,
                                        content_block: { type: 'text', text: '' }
                                    });
                                    hasStartedTextBlock = true;
                                }
                                writeSSEEventLocal('content_block_delta', {
                                    type: 'content_block_delta',
                                    index: textBlockIndex,
                                    delta: { type: 'text_delta', text: newText }
                                });
                            }
                            
                            // 6. Handle tool calls delta
                            const toolCalls = delta?.tool_calls;
                            if (toolCalls && Array.isArray(toolCalls)) {
                                for (const tc of toolCalls) {
                                    const openaiIndex = tc.index;
                                    if (openaiIndex !== undefined) {
                                        if (!toolCallIndexMap.has(openaiIndex)) {
                                            const anthropicIndex = nextAnthropicIndex++;
                                            toolCallIndexMap.set(openaiIndex, anthropicIndex);
                                            
                                            hasToolCalls = true;
                                            
                                            writeSSEEventLocal('content_block_start', {
                                                type: 'content_block_start',
                                                index: anthropicIndex,
                                                content_block: {
                                                    type: 'tool_use',
                                                    id: tc.id || `call_${Math.random().toString(36).substring(7)}`,
                                                    name: tc.function?.name || '',
                                                    input: {}
                                                }
                                            });
                                        }
                                        
                                        const anthropicIndex = toolCallIndexMap.get(openaiIndex);
                                        if (anthropicIndex !== undefined && tc.function?.arguments) {
                                            writeSSEEventLocal('content_block_delta', {
                                                type: 'content_block_delta',
                                                index: anthropicIndex,
                                                delta: {
                                                    type: 'input_json_delta',
                                                    partial_json: tc.function.arguments
                                                }
                                            });
                                        }
                                    }
                                }
                            }
                        } catch (e: any) {
                            this.logToFile(`Error parsing SSE line JSON: ${e.message}`);
                        }
                    }
                }
                
                buffer = buffer.substring(startIndex);
                // Flush the batched SSE events for this network chunk
                flushSSEBuffer();
            }
        } catch (err) {
            // Write error to client if possible
            writeSSEEventLocal('error', {
                type: 'error',
                error: { type: 'api_error', message: 'SSE stream interrupted' }
            });
        } finally {
            clearInterval(keepAliveInterval);

            // Flush parser remaining bytes
            const flushed = parser.flush();
            let newThinking = '';
            let newText = '';
            if (flushed.thinking && !hasProviderReasoning) {
                newThinking += flushed.thinking;
            }
            if (flushed.text) {
                newText += flushed.text;
            }

            if (newThinking && !thinkingBlockClosed) {
                if (!hasStartedThinkingBlock) {
                    thinkingBlockIndex = nextAnthropicIndex++;
                    writeSSEEventLocal('content_block_start', {
                        type: 'content_block_start',
                        index: thinkingBlockIndex,
                        content_block: { type: 'thinking', thinking: '', signature: '' }
                    });
                    hasStartedThinkingBlock = true;
                }
                writeSSEEventLocal('content_block_delta', {
                    type: 'content_block_delta',
                    index: thinkingBlockIndex,
                    delta: { type: 'thinking_delta', thinking: newThinking }
                });
            }

            // Close thinking block if it was left open
            if (hasStartedThinkingBlock && !thinkingBlockClosed) {
                const dummySig = `sig_${Math.random().toString(36).substring(7)}_${Date.now()}`;
                writeSSEEventLocal('content_block_delta', {
                    type: 'content_block_delta',
                    index: thinkingBlockIndex,
                    delta: { type: 'signature_delta', signature: dummySig }
                });
                writeSSEEventLocal('content_block_stop', {
                    type: 'content_block_stop',
                    index: thinkingBlockIndex
                });
                thinkingBlockClosed = true;
            }

            // Flush remaining text
            if (newText && (thinkingBlockClosed || !hasStartedThinkingBlock)) {
                if (!hasStartedTextBlock) {
                    textBlockIndex = nextAnthropicIndex++;
                    writeSSEEventLocal('content_block_start', {
                        type: 'content_block_start',
                        index: textBlockIndex,
                        content_block: { type: 'text', text: '' }
                    });
                    hasStartedTextBlock = true;
                }
                writeSSEEventLocal('content_block_delta', {
                    type: 'content_block_delta',
                    index: textBlockIndex,
                    delta: { type: 'text_delta', text: newText }
                });
            }

            if (hasStartedTextBlock && textBlockIndex !== -1) {
                writeSSEEventLocal('content_block_stop', {
                    type: 'content_block_stop',
                    index: textBlockIndex
                });
            }

            // Clean up and close all tool calls we opened
            for (const [openaiIndex, anthropicIndex] of toolCallIndexMap.entries()) {
                writeSSEEventLocal('content_block_stop', {
                    type: 'content_block_stop',
                    index: anthropicIndex
                });
            }

            // Map stop reason
            let stopReason = 'end_turn';
            if (streamFinishReason === 'tool_calls' || hasToolCalls) {
                stopReason = 'tool_use';
            } else if (streamFinishReason === 'length') {
                stopReason = 'max_tokens';
            }

            writeSSEEventLocal('message_delta', {
                type: 'message_delta',
                delta: { 
                    stop_reason: stopReason, 
                    stop_sequence: null 
                },
                usage: { 
                    output_tokens: streamUsage ? (streamUsage.completion_tokens || 0) : 0 
                }
            });

            writeSSEEventLocal('message_stop', {
                type: 'message_stop'
            });

            flushSSEBuffer();

            if (!res.writableEnded && !res.destroyed) {
                res.end();
            }
        }
    }

    /**
     * Test connection to the target API endpoint.
     */
    public async testConnection(
        apiEndpoint: string,
        apiKey: string,
        model: string,
        modelMapping: Record<string, string>
    ): Promise<{ success: boolean; message: string }> {
        if (!apiEndpoint) {
            return { success: false, message: 'API Endpoint is not configured' };
        }

        try {
            const mappedModel = modelMapping[model] || model;
            const requestBody = {
                model: mappedModel,
                messages: [{ role: 'user', content: 'test connection' }],
                max_tokens: 5,
                stream: false
            };

            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
            };
            if (apiKey) {
                headers['Authorization'] = `Bearer ${apiKey}`;
            }

            const startTime = Date.now();
            const { chatCompletionsUrl } = resolveEndpoints(apiEndpoint);
            const response = await fetch(chatCompletionsUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(requestBody),
                signal: AbortSignal.timeout(8000)
            });

            const duration = Date.now() - startTime;

            if (!response.ok) {
                const errorText = await response.text();
                return {
                    success: false,
                    message: `HTTP ${response.status}: ${errorText.substring(0, 150)}`
                };
            }

            const data = await response.json() as any;
            const reply = data.choices?.[0]?.message?.content || 'Successful connection, but empty text returned.';
            
            return {
                success: true,
                message: `Success (${duration}ms): "${reply.trim()}"`
            };
        } catch (err: any) {
            return {
                success: false,
                message: `Error: ${err.message}`
            };
        }
    }

    /**
     * Helper to write formatted SSE lines.
     */
    private writeSSEEvent(res: http.ServerResponse, event: string, data: any) {
        if (res.writableEnded || res.destroyed) {
            return;
        }
        // this.logToFile(`[WRITE SSE] event: ${event}, data: ${JSON.stringify(data)}`); // Disabled for performance
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
}
