import * as vscode from 'vscode';
import * as path from 'path';
import { resolveEndpoints } from './utils';

export class ToolSupportClaudeViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'tool-support-claude.settingsView';
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _onToggleServer: () => Promise<void>,
        private readonly _isServerRunning: () => boolean,
        private readonly _getServerPort: () => number,
        private readonly _onSyncSettings: (showNotification?: boolean) => Promise<void>,
        private readonly _onTestConnection: (model: string) => Promise<{ success: boolean; message: string }>
    ) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Send initial state to the webview
        this.sendStateToWebview();

        // Reset edit flag and refresh state when view visibility changes (e.g., when the user clicks the sidebar icon)
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                webviewView.webview.postMessage({ type: 'viewVisible' });
                this.sendStateToWebview();
            }
        });

        // Listen for messages from the webview
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.command) {
                case 'saveSettings': {
                    const config = vscode.workspace.getConfiguration('toolSupportClaude');
                    await config.update('apiKey', data.apiKey, vscode.ConfigurationTarget.Global);
                    if (data.apiEndpoint !== undefined) {
                        await config.update('apiEndpoint', data.apiEndpoint, vscode.ConfigurationTarget.Global);
                    }
                    if (data.port !== undefined) {
                        await config.update('port', Number(data.port), vscode.ConfigurationTarget.Global);
                    }
                    
                    vscode.window.showInformationMessage('Tool Support Claude: Configuration saved successfully!');
                    this.sendStateToWebview();
                    break;
                }
                case 'toggleServer': {
                    await this._onToggleServer();
                    this.sendStateToWebview();
                    break;
                }
                case 'loadModels': {
                    await this.fetchModels();
                    break;
                }
                case 'mapModel': {
                    const config = vscode.workspace.getConfiguration('toolSupportClaude');
                    const currentMapping = { ...config.get<Record<string, string>>('modelMapping') || {} };
                    
                    if (data.claudeModel && data.selectedModel !== undefined) {
                        currentMapping[data.claudeModel] = data.selectedModel;
                        
                        // Sync matching alias keys for consistency
                        if (data.claudeModel === 'claude-3-5-sonnet-20241022') {
                            currentMapping['claude-3-5-sonnet-latest'] = data.selectedModel;
                        } else if (data.claudeModel === 'claude-3-5-haiku-20241022') {
                            currentMapping['claude-3-5-haiku-latest'] = data.selectedModel;
                        } else if (data.claudeModel === 'claude-3-opus-20240229') {
                            currentMapping['claude-3-opus-latest'] = data.selectedModel;
                        }
                    }
                    
                    await config.update('modelMapping', currentMapping, vscode.ConfigurationTarget.Global);
                    
                    // Sync to ~/.claude/settings.json ONLY if the server is running
                    if (this._isServerRunning()) {
                        await this._onSyncSettings(false);
                    }
                    
                    this.sendStateToWebview();
                    break;
                }
                case 'testConnection': {
                    const config = vscode.workspace.getConfiguration('toolSupportClaude');
                    const mapping = config.get<Record<string, string>>('modelMapping') || {};
                    const targetModel = mapping['claude-3-5-sonnet-20241022'] || mapping['claude-3-5-haiku-20241022'] || mapping['claude-3-opus-20240229'] || 'default';
                    
                    webviewView.webview.postMessage({ type: 'testStatus', status: 'testing' });
                    
                    const result = await this._onTestConnection(targetModel);
                    
                    webviewView.webview.postMessage({ 
                        type: 'testResult', 
                        success: result.success, 
                        message: result.message 
                    });
                    break;
                }
            }
        });
    }

    /**
     * Send current configuration state and server status to the Webview.
     */
    public sendStateToWebview() {
        if (!this._view) {
            return;
        }

        const config = vscode.workspace.getConfiguration('toolSupportClaude');
        const port = config.get<number>('port') || 20128;
        const apiEndpoint = config.get<string>('apiEndpoint') || '';
        const apiKey = config.get<string>('apiKey') || '';
        const modelMapping = config.get<Record<string, string>>('modelMapping') || {};

        this._view.webview.postMessage({
            type: 'state',
            state: {
                port,
                apiEndpoint,
                apiKey,
                serverRunning: this._isServerRunning(),
                modelMapping
            }
        });
    }

    /**
     * Fetch models from API models list endpoint.
     */
    private async fetchModels() {
        if (!this._view) {
            return;
        }

        const config = vscode.workspace.getConfiguration('toolSupportClaude');
        const apiEndpoint = config.get<string>('apiEndpoint') || '';
        const apiKey = config.get<string>('apiKey') || '';

        if (!apiEndpoint) {
            this._view.webview.postMessage({ 
                type: 'modelsError', 
                error: 'Please configure the API endpoint before loading models.' 
            });
            return;
        }

        this._view.webview.postMessage({ type: 'modelsStatus', status: 'loading' });

        try {
            const { modelsUrl } = resolveEndpoints(apiEndpoint);
            
            const headers: Record<string, string> = {};
            if (apiKey) {
                headers['Authorization'] = `Bearer ${apiKey}`;
            }

            const response = await fetch(modelsUrl, {
                method: 'GET',
                headers
            });

            if (!response.ok) {
                throw new Error(`Server returned status ${response.status}`);
            }

            const data = await response.json() as any;
            
            // Standard OpenAI format has a 'data' array containing model objects
            let models: string[] = [];
            if (data) {
                if (Array.isArray(data.data)) {
                    models = data.data.map((m: any) => typeof m === 'string' ? m : m.id || m.name).filter(Boolean);
                } else if (Array.isArray(data)) {
                    models = data.map((m: any) => typeof m === 'string' ? m : m.id || m.name).filter(Boolean);
                } else if (Array.isArray(data.models)) {
                    models = data.models.map((m: any) => typeof m === 'string' ? m : m.id || m.name).filter(Boolean);
                } else {
                    // Try to extract from any array property (resilient parser)
                    const arrayProp = Object.values(data).find(val => Array.isArray(val)) as any[];
                    if (arrayProp) {
                        models = arrayProp.map((m: any) => typeof m === 'string' ? m : m.id || m.name).filter(Boolean);
                    }
                }
            }

            this._view.webview.postMessage({ 
                type: 'modelsLoaded', 
                models: models.length > 0 ? models : ['default-model']
            });
        } catch (err: any) {
            this._view.webview.postMessage({ 
                type: 'modelsError', 
                error: `Failed to fetch models: ${err.message}. You can manually configure mappings in VS Code Settings if needed.` 
            });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Tool Support Claude Panel</title>
            <style>
                @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap');
                
                :root {
                    --primary-gradient: linear-gradient(135deg, #a855f7, #6366f1);
                    --primary-glow: rgba(99, 102, 241, 0.25);
                    --accent-cyan: #06b6d4;
                    --accent-rose: #f43f5e;
                    --bg-card: rgba(30, 41, 59, 0.45);
                    --border-color: rgba(255, 255, 255, 0.08);
                    --text-main: #f8fafc;
                    --text-muted: #94a3b8;
                    --bg-terminal: rgba(15, 23, 42, 0.75);
                    --bg-body: var(--vscode-sideBar-background);
                }
                
                body.vscode-light {
                    --primary-gradient: linear-gradient(135deg, #8b5cf6, #3b82f6);
                    --primary-glow: rgba(59, 130, 246, 0.15);
                    --accent-cyan: #0891b2;
                    --accent-rose: #e11d48;
                    --bg-card: rgba(241, 245, 249, 0.75);
                    --border-color: rgba(0, 0, 0, 0.08);
                    --text-main: #0f172a;
                    --text-muted: #64748b;
                    --bg-terminal: rgba(248, 250, 252, 0.9);
                }
                
                body {
                    padding: 16px;
                    font-family: 'Outfit', var(--vscode-font-family, system-ui, -apple-system, sans-serif);
                    font-size: var(--vscode-font-size, 13px);
                    color: var(--text-main);
                    background-color: var(--bg-body);
                    margin: 0;
                    box-sizing: border-box;
                    line-height: 1.5;
                }
                
                * {
                    box-sizing: inherit;
                }
                
                .header {
                    margin-bottom: 20px;
                    padding: 4px;
                }
                
                .logo-container {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                
                .logo-dot {
                    width: 8px;
                    height: 8px;
                    background: #a855f7;
                    border-radius: 50%;
                    box-shadow: 0 0 10px #a855f7;
                    animation: logoPulse 2s infinite ease-in-out;
                }
                
                @keyframes logoPulse {
                    0% { transform: scale(1); opacity: 0.6; }
                    50% { transform: scale(1.3); opacity: 1; box-shadow: 0 0 14px #a855f7; }
                    100% { transform: scale(1); opacity: 0.6; }
                }
                
                .header h2 {
                    margin: 0;
                    font-size: 18px;
                    font-weight: 700;
                    letter-spacing: -0.5px;
                    background: var(--primary-gradient);
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                }
                
                .header .badge {
                    font-size: 10px;
                    font-weight: 700;
                    text-transform: uppercase;
                    padding: 2px 6px;
                    border-radius: 4px;
                    background: rgba(139, 92, 246, 0.15);
                    color: #8b5cf6;
                    border: 1px solid rgba(139, 92, 246, 0.3);
                }
                
                .header .subtitle {
                    margin: 4px 0 0 0;
                    font-size: 11px;
                    color: var(--text-muted);
                    line-height: 1.4;
                }
                
                .card {
                    background: var(--bg-card);
                    border: 1px solid var(--border-color);
                    border-radius: 12px;
                    padding: 16px;
                    margin-bottom: 16px;
                    backdrop-filter: blur(12px);
                    -webkit-backdrop-filter: blur(12px);
                    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08);
                    transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), 
                                box-shadow 0.25s cubic-bezier(0.4, 0, 0.2, 1), 
                                border-color 0.25s ease,
                                opacity 0.3s ease,
                                max-height 0.4s ease,
                                margin 0.3s ease,
                                padding 0.3s ease;
                    max-height: 1000px;
                    opacity: 1;
                    overflow: visible;
                }
                
                .card:hover {
                    border-color: rgba(139, 92, 246, 0.3);
                    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
                }
                
                .card.hidden {
                    opacity: 0;
                    max-height: 0;
                    margin: 0;
                    padding: 0;
                    border-color: transparent;
                    border-width: 0;
                    overflow: hidden;
                    pointer-events: none;
                }
                
                h3 {
                    margin-top: 0;
                    margin-bottom: 12px;
                    font-size: 12px;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0.8px;
                    color: var(--text-main);
                }
                
                .status-card {
                    background: linear-gradient(135deg, rgba(30, 41, 59, 0.3), rgba(15, 23, 42, 0.3));
                    border-left: 4px solid var(--text-muted);
                }
                
                .status-card.running {
                    border-left-color: var(--accent-cyan);
                    box-shadow: 0 4px 20px rgba(6, 182, 212, 0.08);
                }
                
                .status-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                }
                
                .status-badge {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                }
                
                .status-indicator {
                    width: 10px;
                    height: 10px;
                    border-radius: 50%;
                    position: relative;
                    background-color: var(--text-muted);
                    transition: all 0.3s ease;
                }
                
                .status-indicator.status-running {
                    background-color: var(--accent-cyan);
                    box-shadow: 0 0 12px var(--accent-cyan);
                }
                
                .status-indicator.status-running::after {
                    content: '';
                    position: absolute;
                    width: 100%;
                    height: 100%;
                    border-radius: 50%;
                    background: var(--accent-cyan);
                    animation: pulse 2s infinite ease-in-out;
                    left: 0;
                    top: 0;
                }
                
                .status-indicator.status-stopped {
                    background-color: var(--accent-rose);
                    box-shadow: 0 0 12px var(--accent-rose);
                }
                
                @keyframes pulse {
                    0% { transform: scale(1); opacity: 0.8; }
                    100% { transform: scale(2.5); opacity: 0; }
                }
                
                .status-info {
                    display: flex;
                    flex-direction: column;
                }
                
                .status-label {
                    font-size: 9px;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    color: var(--text-muted);
                }
                
                .status-value {
                    font-size: 13px;
                    font-weight: 700;
                }
                
                .switch-container {
                    position: relative;
                    display: inline-block;
                    width: 44px;
                    height: 24px;
                }
                
                .switch-container input {
                    opacity: 0;
                    width: 0;
                    height: 0;
                }
                
                .switch-slider {
                    position: absolute;
                    cursor: pointer;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background-color: rgba(255, 255, 255, 0.08);
                    transition: .3s cubic-bezier(0.4, 0, 0.2, 1);
                    border-radius: 24px;
                    border: 1px solid var(--border-color);
                }
                
                .switch-slider:before {
                    position: absolute;
                    content: "";
                    height: 16px;
                    width: 16px;
                    left: 3px;
                    bottom: 3px;
                    background-color: var(--text-muted);
                    transition: .3s cubic-bezier(0.4, 0, 0.2, 1);
                    border-radius: 50%;
                }
                
                body.vscode-light .switch-slider {
                    background-color: rgba(0, 0, 0, 0.06);
                }
                
                input:checked + .switch-slider {
                    background: var(--primary-gradient);
                    border-color: transparent;
                }
                
                input:checked + .switch-slider:before {
                    transform: translateX(20px);
                    background-color: #ffffff;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.25);
                }
                
                .form-group {
                    margin-bottom: 14px;
                }
                
                label {
                    display: block;
                    margin-bottom: 6px;
                    font-size: 10px;
                    font-weight: 600;
                    text-transform: uppercase;
                    letter-spacing: 0.6px;
                    color: var(--text-muted);
                }
                
                input, select {
                    width: 100%;
                    background: var(--vscode-input-background, rgba(30, 41, 59, 0.3));
                    color: var(--vscode-input-foreground, var(--text-main));
                    border: 1px solid var(--vscode-input-border, var(--border-color));
                    border-radius: 8px;
                    padding: 8px 12px;
                    font-family: inherit;
                    font-size: 12px;
                    transition: all 0.2s ease;
                }
                
                input:focus, select:focus {
                    outline: none;
                    border-color: #8b5cf6;
                    box-shadow: 0 0 0 2px var(--primary-glow);
                }
                
                button {
                    background: var(--primary-gradient);
                    color: #ffffff;
                    border: none;
                    border-radius: 8px;
                    padding: 10px 16px;
                    cursor: pointer;
                    font-family: inherit;
                    font-size: 12px;
                    font-weight: 600;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
                    box-shadow: 0 4px 12px var(--primary-glow);
                }
                
                button:hover {
                    transform: translateY(-1px);
                    box-shadow: 0 6px 16px var(--primary-glow);
                    filter: brightness(1.08);
                }
                
                button:active {
                    transform: translateY(1px);
                }
                
                button:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                    transform: none !important;
                    box-shadow: none !important;
                }
                
                button.secondary {
                    background: transparent;
                    color: var(--text-main);
                    border: 1px solid var(--border-color);
                    box-shadow: none;
                }
                
                button.secondary:hover {
                    background: rgba(255, 255, 255, 0.05);
                    border-color: var(--text-muted);
                    transform: translateY(-1px);
                }
                
                body.vscode-light button.secondary:hover {
                    background: rgba(0, 0, 0, 0.03);
                }
                
                /* Config Summary Box */
                .config-summary {
                    background: rgba(0, 0, 0, 0.12);
                    border: 1px solid var(--border-color);
                    border-radius: 8px;
                    padding: 10px 14px;
                    margin-bottom: 12px;
                }
                
                body.vscode-light .config-summary {
                    background: rgba(0, 0, 0, 0.02);
                }
                
                .config-summary-item {
                    display: flex;
                    justify-content: space-between;
                    padding: 6px 0;
                    border-bottom: 1px dashed var(--border-color);
                }
                
                .config-summary-item:last-child {
                    border-bottom: none;
                }
                
                .summary-label {
                    font-size: 11px;
                    color: var(--text-muted);
                }
                
                .summary-value {
                    font-size: 11px;
                    font-weight: 600;
                    color: var(--text-main);
                    word-break: break-all;
                    max-width: 65%;
                    text-align: right;
                }
                
                .mapping-flow {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    background: rgba(0, 0, 0, 0.18);
                    border: 1px solid var(--border-color);
                    border-radius: 8px;
                    padding: 12px;
                    margin-bottom: 12px;
                    gap: 8px;
                }
                
                body.vscode-light .mapping-flow {
                    background: rgba(0, 0, 0, 0.02);
                }
                
                .mapping-node {
                    display: flex;
                    flex-direction: column;
                    flex: 1;
                }
                
                .source-node {
                    align-items: flex-start;
                }
                
                .target-node {
                    align-items: flex-end;
                    max-width: 55%;
                }
                
                .node-label {
                    font-weight: 600;
                    font-size: 11px;
                }
                
                .node-sub {
                    font-size: 8px;
                    color: var(--text-muted);
                    margin-top: 2px;
                    text-transform: uppercase;
                    letter-spacing: 0.3px;
                }
                
                .mapping-arrow {
                    color: var(--text-muted);
                    display: flex;
                    align-items: center;
                    padding: 0;
                    animation: flowPulse 2s infinite ease-in-out;
                }
                
                @keyframes flowPulse {
                    0% { opacity: 0.4; transform: translateX(-2px); }
                    50% { opacity: 1; transform: translateX(2px); }
                    100% { opacity: 0.4; transform: translateX(-2px); }
                }
                
                .target-node select {
                    width: 100%;
                    padding: 4px 6px;
                    font-size: 11px;
                    border-radius: 4px;
                }
                
                .mapping-desc {
                    font-size: 11px;
                    color: var(--text-muted);
                    margin-top: 8px;
                    text-align: center;
                    background: rgba(255, 255, 255, 0.02);
                    padding: 8px;
                    border-radius: 6px;
                    border: 1px dashed var(--border-color);
                }
                
                .card-header-row {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    margin-bottom: 12px;
                }
                
                .card-header-row h3 {
                    margin-bottom: 0;
                }
                
                .btn-small {
                    padding: 6px 12px;
                    font-size: 11px;
                    border-radius: 6px;
                }
                
                .terminal-container {
                    background: var(--bg-terminal);
                    border: 1px solid var(--border-color);
                    border-radius: 8px;
                    overflow: hidden;
                    box-shadow: 0 4px 15px rgba(0,0,0,0.15);
                }
                
                .terminal-header {
                    background: rgba(255, 255, 255, 0.03);
                    border-bottom: 1px solid var(--border-color);
                    padding: 8px 12px;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                }
                
                body.vscode-light .terminal-header {
                    background: rgba(0, 0, 0, 0.02);
                }
                
                .terminal-dot {
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                }
                
                .terminal-dot.red { background-color: #ff5f56; }
                .terminal-dot.yellow { background-color: #ffbd2e; }
                .terminal-dot.green { background-color: #27c93f; }
                
                .terminal-title {
                    font-family: var(--vscode-editor-font-family, monospace);
                    font-size: 9px;
                    color: var(--text-muted);
                    margin-left: 4px;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }
                
                .console-log {
                    padding: 12px;
                    font-family: var(--vscode-editor-font-family, monospace);
                    font-size: 11px;
                    min-height: 80px;
                    max-height: 160px;
                    overflow-y: auto;
                    white-space: pre-wrap;
                    margin: 0;
                    border: none;
                    background: transparent;
                }
                
                .console-success {
                    color: #43eb75;
                }
                
                .console-error {
                    color: #ff5252;
                }
                
                .console-info {
                    color: #40a9ff;
                }
                
                .loader {
                    width: 12px;
                    height: 12px;
                    border: 2px solid var(--text-muted);
                    border-top: 2px solid transparent;
                    border-radius: 50%;
                    animation: spin 0.8s linear infinite;
                    display: inline-block;
                    margin-right: 6px;
                    vertical-align: middle;
                }
                
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
            </style>
        </head>
        <body>
            <!-- Branding Header -->
            <div class="header">
                <div class="logo-container">
                    <span class="logo-dot"></span>
                    <h2>Tool Support Claude</h2>
                    <span class="badge">Proxy</span>
                </div>
                <p class="subtitle">Bridge Claude Code CLI to internal AI APIs</p>
            </div>

            <!-- Card 1: Configuration Settings Card -->
            <div id="configCard" class="card">
                <h3>1. API Configuration</h3>
                
                <!-- View / Summary Mode -->
                <div id="configViewMode" style="display: none;">
                    <div class="config-summary">
                        <div class="config-summary-item">
                            <span class="summary-label">API Endpoint</span>
                            <span id="summaryEndpoint" class="summary-value">-</span>
                        </div>
                        <div class="config-summary-item">
                            <span class="summary-label">API Key</span>
                            <span id="summaryApiKey" class="summary-value">••••••••</span>
                        </div>
                        <div class="config-summary-item">
                            <span class="summary-label">Port</span>
                            <span id="summaryPort" class="summary-value">-</span>
                        </div>
                    </div>
                    <button id="editConfigBtn" class="secondary" style="width: 100%;">Edit Configuration</button>
                </div>
                
                <!-- Edit Mode -->
                <div id="configEditMode">
                    <div class="form-group">
                        <label for="apiEndpoint">API Endpoint</label>
                        <input type="text" id="apiEndpoint" placeholder="https://ask.ai.gameloft.org/api">
                    </div>
                    <div class="form-group">
                        <label for="apiKey">API Key</label>
                        <input type="password" id="apiKey" placeholder="api_key...">
                    </div>
                    <div class="form-group">
                        <label for="port">Proxy Port</label>
                        <input type="number" id="port" placeholder="20128">
                    </div>
                    <button id="saveConfigBtn" style="width: 100%;">Save Configuration</button>
                </div>
            </div>

            <!-- Card 2: Model Mapping Card (Progressive Phase 2) -->
            <div id="mappingCard" class="card hidden">
                <h3>2. Model Mapping</h3>
                <button id="loadModelsBtn" class="secondary" style="margin-bottom: 12px; width: 100%;">
                    <span id="loadModelsSpinner" class="loader" style="display: none;"></span>
                    <span id="loadModelsBtnText">Load Models</span>
                </button>
                
                <!-- Claude Sonnet Mapping Flow -->
                <div class="mapping-flow">
                    <div class="mapping-node source-node">
                        <span class="node-label">Claude Sonnet</span>
                        <span class="node-sub">Requested by CLI</span>
                    </div>
                    <div class="mapping-arrow">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                            <polyline points="12 5 19 12 12 19"></polyline>
                        </svg>
                    </div>
                    <div class="mapping-node target-node">
                        <select id="sonnetModelSelect" disabled>
                            <option value="">-- Load models first --</option>
                        </select>
                        <span class="node-sub">Mapped Model</span>
                    </div>
                </div>

                <!-- Claude Haiku Mapping Flow -->
                <div class="mapping-flow">
                    <div class="mapping-node source-node">
                        <span class="node-label">Claude Haiku</span>
                        <span class="node-sub">Requested by CLI</span>
                    </div>
                    <div class="mapping-arrow">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                            <polyline points="12 5 19 12 12 19"></polyline>
                        </svg>
                    </div>
                    <div class="mapping-node target-node">
                        <select id="haikuModelSelect" disabled>
                            <option value="">-- Load models first --</option>
                        </select>
                        <span class="node-sub">Mapped Model</span>
                    </div>
                </div>

                <!-- Claude Opus Mapping Flow -->
                <div class="mapping-flow">
                    <div class="mapping-node source-node">
                        <span class="node-label">Claude Opus</span>
                        <span class="node-sub">Requested by CLI</span>
                    </div>
                    <div class="mapping-arrow">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                            <polyline points="12 5 19 12 12 19"></polyline>
                        </svg>
                    </div>
                    <div class="mapping-node target-node">
                        <select id="opusModelSelect" disabled>
                            <option value="">-- Load models first --</option>
                        </select>
                        <span class="node-sub">Mapped Model</span>
                    </div>
                </div>
                
                <div id="currentMappingDesc" class="mapping-desc">
                    Not mapped.
                </div>
            </div>

            <!-- Card 3: Host Server Status Card (Progressive Phase 3) -->
            <div id="serverControlCard" class="card status-card card-container hidden">
                <div class="status-header">
                    <div class="status-badge">
                        <span id="statusIndicator" class="status-indicator"></span>
                        <div class="status-info">
                            <span class="status-label">Host Status</span>
                            <span id="statusText" class="status-value">Checking...</span>
                        </div>
                    </div>
                    <label class="switch-container">
                        <input type="checkbox" id="serverToggleCheckbox">
                        <span class="switch-slider"></span>
                    </label>
                </div>
            </div>

            <!-- Card 4: Diagnostics Card (Progressive Phase 3) -->
            <div id="diagnosticsCard" class="card hidden">
                <div class="card-header-row">
                    <h3>Diagnostics</h3>
                    <button id="testConnBtn" class="secondary btn-small">Test Connection</button>
                </div>
                
                <div class="terminal-container">
                    <div class="terminal-header">
                        <div class="terminal-dot red"></div>
                        <div class="terminal-dot yellow"></div>
                        <div class="terminal-dot green"></div>
                        <div class="terminal-title">diagnostics.log</div>
                    </div>
                    <div id="consoleLog" class="console-log">Ready.</div>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                
                // Elements
                const serverControlCard = document.getElementById('serverControlCard');
                const statusIndicator = document.getElementById('statusIndicator');
                const statusText = document.getElementById('statusText');
                const serverToggleCheckbox = document.getElementById('serverToggleCheckbox');
                
                const configCard = document.getElementById('configCard');
                const configEditMode = document.getElementById('configEditMode');
                const configViewMode = document.getElementById('configViewMode');
                const editConfigBtn = document.getElementById('editConfigBtn');
                
                const apiEndpointInput = document.getElementById('apiEndpoint');
                const apiKeyInput = document.getElementById('apiKey');
                const portInput = document.getElementById('port');
                const saveConfigBtn = document.getElementById('saveConfigBtn');
                
                const summaryEndpoint = document.getElementById('summaryEndpoint');
                const summaryApiKey = document.getElementById('summaryApiKey');
                const summaryPort = document.getElementById('summaryPort');
                
                const mappingCard = document.getElementById('mappingCard');
                const diagnosticsCard = document.getElementById('diagnosticsCard');
                
                const loadModelsBtn = document.getElementById('loadModelsBtn');
                const loadModelsSpinner = document.getElementById('loadModelsSpinner');
                const loadModelsBtnText = document.getElementById('loadModelsBtnText');
                
                const sonnetModelSelect = document.getElementById('sonnetModelSelect');
                const haikuModelSelect = document.getElementById('haikuModelSelect');
                const opusModelSelect = document.getElementById('opusModelSelect');
                
                const currentMappingDesc = document.getElementById('currentMappingDesc');
                
                const testConnBtn = document.getElementById('testConnBtn');
                const consoleLog = document.getElementById('consoleLog');

                let currentSonnetModel = '';
                let currentHaikuModel = '';
                let currentOpusModel = '';
                let currentServerRunning = false;
                let isEditingConfigExplicitly = false;

                // Helper to select option in a specific dropdown
                function selectDropdownOption(selectEl, modelName) {
                    if (!selectEl) return;
                    for (let i = 0; i < selectEl.options.length; i++) {
                        if (selectEl.options[i].value === modelName) {
                            selectEl.selectedIndex = i;
                            return;
                        }
                    }
                    selectEl.selectedIndex = 0;
                }

                // Update UI from state
                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.type) {
                        case 'viewVisible': {
                            isEditingConfigExplicitly = false;
                            break;
                        }
                        case 'state': {
                            const state = message.state;
                            
                            // Host state
                            currentServerRunning = state.serverRunning;
                            serverToggleCheckbox.checked = state.serverRunning;
                            if (state.serverRunning) {
                                serverControlCard.classList.add('running');
                                statusIndicator.className = 'status-indicator status-running';
                                statusText.textContent = 'Running (' + state.port + ')';
                            } else {
                                serverControlCard.classList.remove('running');
                                statusIndicator.className = 'status-indicator status-stopped';
                                statusText.textContent = 'Stopped';
                            }
                            
                            // Input fields
                            apiEndpointInput.value = state.apiEndpoint || '';
                            apiKeyInput.value = state.apiKey || '';
                            portInput.value = state.port || 20128;
                            
                            // Selected models
                            const mapping = state.modelMapping || {};
                            currentSonnetModel = mapping['claude-3-5-sonnet-20241022'] || '';
                            currentHaikuModel = mapping['claude-3-5-haiku-20241022'] || '';
                            currentOpusModel = mapping['claude-3-opus-20240229'] || '';
                            
                            // Progressive Discovery Flow Controls
                            const hasValidConfig = state.apiEndpoint && state.apiKey;
                            
                            if (hasValidConfig && !isEditingConfigExplicitly) {
                                // 1. Show Config in Summary Mode (Read-Only)
                                configEditMode.style.display = 'none';
                                configViewMode.style.display = 'block';
                                
                                summaryEndpoint.textContent = state.apiEndpoint;
                                summaryPort.textContent = state.port;
                                summaryApiKey.textContent = '••••••••';
                                
                                // 2. Show Phase 2: Model Mapping
                                mappingCard.classList.remove('hidden');
                            } else {
                                // Show Config in Edit Mode
                                configEditMode.style.display = 'block';
                                configViewMode.style.display = 'none';
                                
                                // Hide subsequent phases
                                mappingCard.classList.add('hidden');
                                serverControlCard.classList.add('hidden');
                                diagnosticsCard.classList.add('hidden');
                            }
                            
                            // 3. Show Phase 3: Toggle switch & diagnostics ONLY if configuration is valid and not editing
                            if (hasValidConfig && !isEditingConfigExplicitly) {
                                serverControlCard.classList.remove('hidden');
                                diagnosticsCard.classList.remove('hidden');
                            } else {
                                serverControlCard.classList.add('hidden');
                                diagnosticsCard.classList.add('hidden');
                            }
                            
                            selectDropdownOption(sonnetModelSelect, currentSonnetModel);
                            selectDropdownOption(haikuModelSelect, currentHaikuModel);
                            selectDropdownOption(opusModelSelect, currentOpusModel);
                            
                            let descHtml = '<div style="text-align: left; padding: 4px;"><strong style="font-size: 11px;">Current Mappings:</strong><ul style="margin: 4px 0 0 0; padding-left: 16px; color: var(--text-muted);">';
                            descHtml += '<li>Sonnet: <strong style="color: var(--text-main);">' + (currentSonnetModel || 'Not mapped') + '</strong></li>';
                            descHtml += '<li>Haiku: <strong style="color: var(--text-main);">' + (currentHaikuModel || 'Not mapped') + '</strong></li>';
                            descHtml += '<li>Opus: <strong style="color: var(--text-main);">' + (currentOpusModel || 'Not mapped') + '</strong></li>';
                            descHtml += '</ul></div>';
                            currentMappingDesc.innerHTML = descHtml;
                            break;
                        }
                        case 'modelsStatus': {
                            if (message.status === 'loading') {
                                loadModelsSpinner.style.display = 'inline-block';
                                loadModelsBtnText.textContent = 'Loading...';
                                loadModelsBtn.disabled = true;
                            }
                            break;
                        }
                        case 'modelsLoaded': {
                            loadModelsSpinner.style.display = 'none';
                            loadModelsBtnText.textContent = 'Reload Models';
                            loadModelsBtn.disabled = false;
                            
                            const selects = [sonnetModelSelect, haikuModelSelect, opusModelSelect];
                            
                            selects.forEach(select => {
                                if (select) {
                                    select.innerHTML = '';
                                    select.disabled = false;
                                    
                                    const defaultOption = document.createElement('option');
                                    defaultOption.value = '';
                                    defaultOption.textContent = '-- Select Model --';
                                    select.appendChild(defaultOption);
                                    
                                    message.models.forEach(model => {
                                        const option = document.createElement('option');
                                        option.value = model;
                                        option.textContent = model;
                                        select.appendChild(option);
                                    });
                                }
                            });

                            selectDropdownOption(sonnetModelSelect, currentSonnetModel);
                            selectDropdownOption(haikuModelSelect, currentHaikuModel);
                            selectDropdownOption(opusModelSelect, currentOpusModel);
                            
                            log('Successfully loaded ' + message.models.length + ' models.', 'success');
                            break;
                        }
                        case 'modelsError': {
                            loadModelsSpinner.style.display = 'none';
                            loadModelsBtnText.textContent = 'Load Models';
                            loadModelsBtn.disabled = false;
                            log(message.error, 'error');
                            break;
                        }
                        case 'testStatus': {
                            if (message.status === 'testing') {
                                log('Testing connection to endpoint...', 'info');
                                testConnBtn.disabled = true;
                            }
                            break;
                        }
                        case 'testResult': {
                            testConnBtn.disabled = false;
                            if (message.success) {
                                log('Success: ' + message.message, 'success');
                            } else {
                                log('Failure: ' + message.message, 'error');
                            }
                            break;
                        }
                    }
                });

                // Event Listeners
                serverToggleCheckbox.addEventListener('change', () => {
                    vscode.postMessage({ command: 'toggleServer' });
                });

                editConfigBtn.addEventListener('click', () => {
                    isEditingConfigExplicitly = true;
                    configEditMode.style.display = 'block';
                    configViewMode.style.display = 'none';
                    
                    // Collapse/Hide next steps while editing configuration
                    mappingCard.classList.add('hidden');
                    serverControlCard.classList.add('hidden');
                    diagnosticsCard.classList.add('hidden');
                });

                saveConfigBtn.addEventListener('click', () => {
                    isEditingConfigExplicitly = false;
                    vscode.postMessage({
                        command: 'saveSettings',
                        apiEndpoint: apiEndpointInput.value,
                        apiKey: apiKeyInput.value,
                        port: portInput.value
                    });
                });

                loadModelsBtn.addEventListener('click', () => {
                    vscode.postMessage({ command: 'loadModels' });
                });

                sonnetModelSelect.addEventListener('change', () => {
                    vscode.postMessage({
                        command: 'mapModel',
                        claudeModel: 'claude-3-5-sonnet-20241022',
                        selectedModel: sonnetModelSelect.value
                    });
                });

                haikuModelSelect.addEventListener('change', () => {
                    vscode.postMessage({
                        command: 'mapModel',
                        claudeModel: 'claude-3-5-haiku-20241022',
                        selectedModel: haikuModelSelect.value
                    });
                });

                opusModelSelect.addEventListener('change', () => {
                    vscode.postMessage({
                        command: 'mapModel',
                        claudeModel: 'claude-3-opus-20240229',
                        selectedModel: opusModelSelect.value
                    });
                });

                testConnBtn.addEventListener('click', () => {
                    vscode.postMessage({ command: 'testConnection' });
                });

                function log(msg, type = 'info') {
                    const time = new Date().toLocaleTimeString();
                    const span = document.createElement('span');
                    span.className = 'console-' + type;
                    span.textContent = '[' + time + '] ' + msg + '\\n';
                    
                    consoleLog.appendChild(span);
                    consoleLog.scrollTop = consoleLog.scrollHeight;
                }
            </script>
        </body>
        </html>`;
    }
}
