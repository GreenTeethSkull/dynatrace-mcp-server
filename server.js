require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const app = express();
const port = process.env.PORT || 8000;

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// MCP Server instance
let mcpProcess = null;
let mcpReady = false;
let pendingRequests = new Map();

// Initialize MCP Server
function initializeMCP() {
    return new Promise((resolve, reject) => {
        console.log('Starting Dynatrace MCP Server...');

        const env = {
            ...process.env,
            DT_PLATFORM_TOKEN: process.env.DT_PLATFORM_TOKEN,
            DT_ENVIRONMENT: process.env.DT_ENVIRONMENT,
            NODE_ENV: 'production'
        };

        // Validate required environment variables
        if (!env.DT_PLATFORM_TOKEN || !env.DT_ENVIRONMENT) {
            reject(new Error('DT_PLATFORM_TOKEN and DT_ENVIRONMENT are required'));
            return;
        }

        mcpProcess = spawn('npx', ['-y', '@dynatrace-oss/dynatrace-mcp-server@latest'], {
            env: env,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: true
        });

        let initBuffer = '';

        mcpProcess.stdout.on('data', (data) => {
            const chunk = data.toString();
            console.log('MCP stdout:', chunk);

            // Handle initialization
            if (!mcpReady) {
                initBuffer += chunk;
                if (initBuffer.includes('Server ready') ||
                    initBuffer.includes('Dynatrace MCP Server running') ||
                    chunk.includes('"method":"notifications/initialized"')) {
                    mcpReady = true;
                    console.log('MCP Server is ready!');
                    resolve();
                    return;
                }
            }

            // Handle responses to pending requests
            const lines = chunk.split('\n').filter(line => line.trim());
            for (const line of lines) {
                try {
                    const response = JSON.parse(line);
                    if (response.id && pendingRequests.has(response.id)) {
                        const { resolve: resolveRequest } = pendingRequests.get(response.id);
                        pendingRequests.delete(response.id);
                        resolveRequest(response);
                    }
                } catch (e) {
                    // Not a JSON response, continue
                }
            }
        });

        mcpProcess.stderr.on('data', (data) => {
            const chunk = data.toString();
            console.error('MCP stderr:', chunk);

            // Some MCP servers log ready state to stderr
            if (!mcpReady && (chunk.includes('running on stdio') || chunk.includes('Server ready'))) {
                mcpReady = true;
                console.log('MCP Server is ready! (from stderr)');
                resolve();
            }
        });

        mcpProcess.on('close', (code) => {
            console.log(`MCP process exited with code ${code}`);
            mcpReady = false;
            // Reject all pending requests
            for (const [id, { reject: rejectRequest }] of pendingRequests) {
                rejectRequest(new Error('MCP process closed'));
            }
            pendingRequests.clear();
        });

        mcpProcess.on('error', (error) => {
            console.error('MCP process error:', error);
            mcpReady = false;
            reject(error);
        });

        // Initialize the MCP server with handshake
        setTimeout(() => {
            if (mcpProcess && mcpProcess.stdin) {
                const initMessage = {
                    jsonrpc: '2.0',
                    id: uuidv4(),
                    method: 'initialize',
                    params: {
                        protocolVersion: '2024-11-05',
                        capabilities: {
                            tools: {}
                        },
                        clientInfo: {
                            name: 'dynatrace-http-bridge',
                            version: '1.0.0'
                        }
                    }
                };
                mcpProcess.stdin.write(JSON.stringify(initMessage) + '\n');
            }
        }, 1000);

        // Timeout after 60 seconds
        setTimeout(() => {
            if (!mcpReady) {
                reject(new Error('MCP server initialization timeout'));
            }
        }, 60000);
    });
}

// Send message to MCP and get response
function sendToMCP(message) {
    return new Promise((resolve, reject) => {
        if (!mcpProcess || !mcpReady) {
            reject(new Error('MCP server not ready'));
            return;
        }

        const requestId = message.id || uuidv4();
        message.id = requestId;

        // Store the request
        pendingRequests.set(requestId, { resolve, reject });

        try {
            mcpProcess.stdin.write(JSON.stringify(message) + '\n');
        } catch (error) {
            pendingRequests.delete(requestId);
            reject(error);
        }

        // Timeout after 30 seconds
        setTimeout(() => {
            if (pendingRequests.has(requestId)) {
                pendingRequests.delete(requestId);
                reject(new Error('MCP response timeout'));
            }
        }, 30000);
    });
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        mcpReady: mcpReady,
        timestamp: new Date().toISOString(),
        service: 'dynatrace-mcp-http-bridge'
    });
});

// Get server info
app.get('/info', async (req, res) => {
    try {
        if (!mcpReady) {
            return res.status(503).json({
                error: 'MCP server not ready',
                message: 'Please wait for the MCP server to initialize'
            });
        }

        const response = await sendToMCP({
            jsonrpc: '2.0',
            id: uuidv4(),
            method: 'initialize',
            params: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                clientInfo: { name: 'info-request', version: '1.0.0' }
            }
        });

        res.json(response);
    } catch (error) {
        console.error('Info error:', error);
        res.status(500).json({
            error: 'Failed to get server info',
            message: error.message
        });
    }
});

// List available tools endpoint
app.get('/tools', async (req, res) => {
    try {
        if (!mcpReady) {
            return res.status(503).json({
                error: 'MCP server not ready',
                message: 'Please wait for the MCP server to initialize'
            });
        }

        const response = await sendToMCP({
            jsonrpc: '2.0',
            id: uuidv4(),
            method: 'tools/list'
        });

        res.json(response);
    } catch (error) {
        console.error('Tools list error:', error);
        res.status(500).json({
            error: 'Failed to get tools list',
            message: error.message
        });
    }
});

// Execute tool endpoint - Compatible with Copilot Studio
app.post('/tools/:toolName', async (req, res) => {
    try {
        if (!mcpReady) {
            return res.status(503).json({
                error: 'MCP server not ready',
                message: 'Please wait for the MCP server to initialize'
            });
        }

        const { toolName } = req.params;
        const toolArgs = req.body || {};

        console.log(`Executing tool: ${toolName} with args:`, toolArgs);

        const response = await sendToMCP({
            jsonrpc: '2.0',
            id: uuidv4(),
            method: 'tools/call',
            params: {
                name: toolName,
                arguments: toolArgs
            }
        });

        // Format response for Copilot Studio
        if (response.result && response.result.content) {
            const content = response.result.content;
            let formattedResult = '';

            for (const item of content) {
                if (item.type === 'text') {
                    formattedResult += item.text + '\n';
                }
            }

            res.json({
                success: true,
                result: formattedResult.trim(),
                raw: response
            });
        } else {
            res.json({
                success: false,
                error: response.error || 'Unknown error',
                raw: response
            });
        }

    } catch (error) {
        console.error('Tool execution error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to execute tool',
            message: error.message
        });
    }
});

// Generic MCP endpoint for advanced usage
app.post('/mcp', async (req, res) => {
    try {
        if (!mcpReady) {
            return res.status(503).json({
                error: 'MCP server not ready',
                message: 'Please wait for the MCP server to initialize'
            });
        }

        const { method, params } = req.body;

        if (!method) {
            return res.status(400).json({
                error: 'Missing method parameter'
            });
        }

        const mcpRequest = {
            jsonrpc: '2.0',
            id: uuidv4(),
            method: method,
            params: params || {}
        };

        const response = await sendToMCP(mcpRequest);
        res.json(response);

    } catch (error) {
        console.error('MCP proxy error:', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message
        });
    }
});

// Copilot Studio compatible endpoints
app.get('/api/tools', async (req, res) => {
    // Redirect to /tools
    return app._router.handle({ ...req, url: '/tools', method: 'GET' }, res);
});

app.post('/api/tools/:toolName/execute', async (req, res) => {
    // Redirect to /tools/:toolName
    req.params = { toolName: req.params.toolName };
    return app._router.handle({ ...req, url: `/tools/${req.params.toolName}`, method: 'POST' }, res);
});

// Root endpoint with API documentation
app.get('/', (req, res) => {
    res.json({
        name: 'Dynatrace MCP HTTP Bridge',
        version: '1.0.0',
        description: 'HTTP bridge for Dynatrace MCP Server - Compatible with Copilot Studio',
        endpoints: {
            'GET /health': 'Health check',
            'GET /info': 'Server information',
            'GET /tools': 'List available tools',
            'POST /tools/:toolName': 'Execute a specific tool',
            'POST /mcp': 'Generic MCP JSON-RPC endpoint',
            'GET /api/tools': 'Alternative tools list endpoint',
            'POST /api/tools/:toolName/execute': 'Alternative tool execution endpoint'
        },
        mcpReady: mcpReady,
        timestamp: new Date().toISOString()
    });
});

// Start server
async function startServer() {
    try {
        console.log('Starting Dynatrace MCP HTTP Bridge...');
        console.log('Environment:', process.env.DT_ENVIRONMENT);
        console.log('Token configured:', !!process.env.DT_PLATFORM_TOKEN);

        await initializeMCP();
        console.log('MCP server initialized successfully!');

        app.listen(port, '0.0.0.0', () => {
            console.log(`Dynatrace MCP HTTP Bridge running on port ${port}`);
            console.log(`Health check: http://localhost:${port}/health`);
            console.log(`Tools list: http://localhost:${port}/tools`);
            console.log(`API documentation: http://localhost:${port}/`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully');
    if (mcpProcess) {
        mcpProcess.kill('SIGTERM');
    }
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down gracefully');
    if (mcpProcess) {
        mcpProcess.kill('SIGINT');
    }
    process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    if (mcpProcess) {
        mcpProcess.kill();
    }
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

startServer();