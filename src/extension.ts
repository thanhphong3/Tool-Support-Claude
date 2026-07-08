import * as vscode from 'vscode';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ProxyServer } from './proxyServer';
import { ToolSupportClaudeViewProvider } from './webviewProvider';

let proxyServer: ProxyServer;
let statusBarItem: vscode.StatusBarItem;
let webviewProvider: ToolSupportClaudeViewProvider;

export async function activate(context: vscode.ExtensionContext) {
    console.log('Tool Support Claude extension is now active.');

    // Initialize proxy server instance
    proxyServer = new ProxyServer();

    // Register Status Bar Item
    statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    statusBarItem.command = 'tool-support-claude.toggleServer';
    context.subscriptions.push(statusBarItem);

    // Initialize Webview View Provider
    webviewProvider = new ToolSupportClaudeViewProvider(
        context.extensionUri,
        async () => {
            await toggleServerState();
        },
        () => proxyServer.isRunning(),
        () => {
            const config = vscode.workspace.getConfiguration('toolSupportClaude');
            return config.get<number>('port') || 20128;
        },
        async (showNotification: boolean = false) => {
            await configureClaudeCode(showNotification);
        },
        async (model: string) => {
            const config = vscode.workspace.getConfiguration('toolSupportClaude');
            const apiEndpoint = config.get<string>('apiEndpoint') || '';
            const apiKey = config.get<string>('apiKey') || '';
            const modelMapping = config.get<Record<string, string>>('modelMapping') || {};
            return await proxyServer.testConnection(apiEndpoint, apiKey, model, modelMapping);
        }
    );

    const registeredProvider = vscode.window.registerWebviewViewProvider(
        ToolSupportClaudeViewProvider.viewType,
        webviewProvider
    );
    context.subscriptions.push(registeredProvider);

    // Register Commands
    const toggleCommand = vscode.commands.registerCommand('tool-support-claude.toggleServer', async () => {
        await toggleServerState();
    });

    const configureCommand = vscode.commands.registerCommand('tool-support-claude.connectClaude', async () => {
        if (!proxyServer.isRunning()) {
            vscode.window.showWarningMessage('Tool Support Claude: Server is not running. Please start the proxy server first.');
            return;
        }
        await configureClaudeCode(true);
    });

    context.subscriptions.push(toggleCommand, configureCommand);

    // Watch for VS Code config changes to restart the server on new parameters if it is running
    const configWatcher = vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (e.affectsConfiguration('toolSupportClaude')) {
            webviewProvider?.sendStateToWebview();
            if (proxyServer.isRunning()) {
                vscode.window.showInformationMessage('Tool Support Claude: Settings updated, restarting proxy server...');
                await proxyServer.stop();
                await startProxyServer(false); // Restart silently without showing excessive popup messages
            }
        }
    });
    context.subscriptions.push(configWatcher);

    // By default, do not start the host; initialize the status bar as stopped
    updateStatusBar(false);
}

export async function deactivate() {
    if (proxyServer && proxyServer.isRunning()) {
        await proxyServer.stop();
    }
    await removeClaudeCodeConfig();
}

/**
 * Start the local proxy server using the parameters from configuration.
 */
async function startProxyServer(showNotification: boolean): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('toolSupportClaude');
    const port = config.get<number>('port') || 20128;
    const apiEndpoint = config.get<string>('apiEndpoint') || '';
    const apiKey = config.get<string>('apiKey') || '';
    const modelMapping = config.get<Record<string, string>>('modelMapping') || {};
    const timeout = config.get<number>('timeout') || 900;

    if (!apiEndpoint) {
        updateStatusBar(false);
        webviewProvider?.sendStateToWebview();
        vscode.window.showErrorMessage(
            'Tool Support Claude: API Endpoint is not configured. Please check your settings.',
            'Open Settings'
        ).then(selection => {
            if (selection === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'toolSupportClaude');
            }
        });
        return false;
    }

    try {
        await proxyServer.start(port, apiEndpoint, apiKey, modelMapping, timeout);
        updateStatusBar(true, port);
        webviewProvider?.sendStateToWebview();
        if (showNotification) {
            vscode.window.showInformationMessage(`Tool Support Claude: Server started successfully on port ${port}.`);
        }
        await configureClaudeCode(showNotification);
        return true;
    } catch (err: any) {
        updateStatusBar(false);
        webviewProvider?.sendStateToWebview();
        vscode.window.showErrorMessage(`Tool Support Claude: Failed to start server: ${err.message}`);
        return false;
    }
}

/**
 * Toggle the server on or off.
 */
async function toggleServerState() {
    if (proxyServer.isRunning()) {
        await proxyServer.stop();
        updateStatusBar(false);
        webviewProvider?.sendStateToWebview();
        vscode.window.showInformationMessage('Tool Support Claude: Local server stopped.');
        await removeClaudeCodeConfig();
    } else {
        await startProxyServer(true);
    }
}

/**
 * Update the Status Bar Item's text, tooltip, and icon.
 */
function updateStatusBar(running: boolean, port?: number) {
    if (running && port) {
        statusBarItem.text = `$(broadcast) Tool Support Claude: Running (${port})`;
        statusBarItem.tooltip = 'Tool Support Claude is active. Click to stop the server.';
        statusBarItem.backgroundColor = undefined;
    } else {
        statusBarItem.text = `$(circle-slash) Tool Support Claude: Stopped`;
        statusBarItem.tooltip = 'Tool Support Claude is offline. Click to start the server.';
        // Light caution warning background when stopped
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    statusBarItem.show();
}

/**
 * Read, edit, and write standard settings to ~/.claude/settings.json
 */
async function configureClaudeCode(showNotification: boolean = false) {
    const config = vscode.workspace.getConfiguration('toolSupportClaude');
    const port = config.get<number>('port') || 20128;
    const modelMapping = config.get<Record<string, string>>('modelMapping') || {};

    const homedir = os.homedir();
    const claudeDir = path.join(homedir, '.claude');
    const settingsPath = path.join(claudeDir, 'settings.json');

    try {
        // Ensure .claude directory exists
        await fsp.mkdir(claudeDir, { recursive: true });

        let settingsJson: Record<string, any> = {};
        try {
            const existingContent = await fsp.readFile(settingsPath, 'utf8');
            settingsJson = JSON.parse(existingContent);
        } catch (e: any) {
            if (e.code !== 'ENOENT') {
                // If it fails to parse (malformed), start fresh but warn
                console.warn('Failed to parse existing ~/.claude/settings.json, overwriting.');
            }
        }

        // Set parameters
        const proxyUrl = `http://127.0.0.1:${port}/v1`;
        const authToken = 'sk_9router';

        // Clean up old root-level keys if they exist
        delete settingsJson['ANTHROPIC_BASE_URL'];
        delete settingsJson['ANTHROPIC_AUTH_TOKEN'];
        delete settingsJson['apiBaseUrl'];
        delete settingsJson['primaryApiKey'];
        delete settingsJson['models'];

        // Set top-level flags
        settingsJson['hasCompletedOnboarding'] = true;

        // Ensure env object exists
        if (!settingsJson['env'] || typeof settingsJson['env'] !== 'object') {
            settingsJson['env'] = {};
        }

        // 1. Inject exact environment variable keys inside env object
        settingsJson['env']['ANTHROPIC_BASE_URL'] = proxyUrl;
        settingsJson['env']['ANTHROPIC_AUTH_TOKEN'] = authToken;

        // 2. Resolve mapped target models if defined, otherwise fall back to standard Anthropic model names
        const sonnetModel = modelMapping['claude-3-5-sonnet-20241022'] || modelMapping['claude-3-5-sonnet-latest'] || 'claude-3-5-sonnet-20241022';
        const haikuModel = modelMapping['claude-3-5-haiku-20241022'] || modelMapping['claude-3-5-haiku-latest'] || 'claude-3-5-haiku-20241022';
        const opusModel = modelMapping['claude-3-opus-20240229'] || modelMapping['claude-3-opus-latest'] || 'claude-3-opus-20240229';

        settingsJson['env']['ANTHROPIC_DEFAULT_SONNET_MODEL'] = sonnetModel;
        settingsJson['env']['ANTHROPIC_DEFAULT_HAIKU_MODEL'] = haikuModel;
        settingsJson['env']['ANTHROPIC_DEFAULT_OPUS_MODEL'] = opusModel;

        // Save updated JSON
        await fsp.writeFile(settingsPath, JSON.stringify(settingsJson, null, 2), 'utf8');

        if (showNotification) {
            vscode.window.showInformationMessage(
                `Tool Support Claude: Configured Claude Code settings at ${settingsPath}.`,
                'Open Settings File'
            ).then(selection => {
                if (selection === 'Open Settings File') {
                    vscode.workspace.openTextDocument(settingsPath).then(doc => {
                        vscode.window.showTextDocument(doc);
                    });
                }
            });
        }
    } catch (err: any) {
        vscode.window.showErrorMessage(`Tool Support Claude: Failed to configure Claude Code settings: ${err.message}`);
    }
}

/**
 * Delete the Claude Code configuration file ~/.claude/settings.json
 */
async function removeClaudeCodeConfig() {
    const homedir = os.homedir();
    const settingsPath = path.join(homedir, '.claude', 'settings.json');
    try {
        await fsp.unlink(settingsPath);
        console.log('Tool Support Claude: Deleted Claude Code settings file at:', settingsPath);
    } catch (err: any) {
        if (err.code !== 'ENOENT') {
            console.error(`Tool Support Claude: Failed to delete Claude Code settings: ${err.message}`);
        }
    }
}

