/**
 * Resolves the chat completions and models endpoints based on the configured URL.
 * Supports both full endpoint URLs and base URLs.
 */
export function resolveEndpoints(configUrl: string): { chatCompletionsUrl: string; modelsUrl: string } {
    let baseUrl = configUrl.trim();
    
    // Remove trailing slash
    if (baseUrl.endsWith('/')) {
        baseUrl = baseUrl.slice(0, -1);
    }

    let chatCompletionsUrl = '';
    let modelsUrl = '';

    if (baseUrl.endsWith('/chat/completions')) {
        chatCompletionsUrl = baseUrl;
        // Slice off /chat/completions to get the base
        const base = baseUrl.slice(0, -'/chat/completions'.length);
        // Ensure base doesn't have trailing slash
        const cleanBase = base.endsWith('/') ? base.slice(0, -1) : base;
        modelsUrl = `${cleanBase}/models`;
    } else if (baseUrl.endsWith('/v1')) {
        chatCompletionsUrl = `${baseUrl}/chat/completions`;
        modelsUrl = `${baseUrl}/models`;
    } else {
        // Treat as the generic API base URL (e.g. https://api.your-provider.com/v1)
        chatCompletionsUrl = `${baseUrl}/chat/completions`;
        modelsUrl = `${baseUrl}/models`;
    }

    return {
        chatCompletionsUrl,
        modelsUrl
    };
}
