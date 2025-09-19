const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// MCP Server instance
let mcpProcess = null;
let mcpReady = false;

// Initialize MCP Server
function initializeMCP() {
    return new Promise((resolve, reject) => {
        const env = {
            ...process.env,
            DT_PLATFORM_TOKEN: process.env.DT_PLATFORM_TOKEN,
            DT_ENVIRONMENT: process.env.DT_ENVIRONMENT
        };

        mcpProcess = spawn('npx', ['-y', '@dynatrace-oss/dynatrace-mcp-server@latest'], {
            env: env,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        mcpProcess.stdout.on('data', (data) => {
            console.log('MCP stdout:', data.toString());
            if (!mcpReady && data.toString().includes('Server ready')) {
                mcpReady = true;
                resolve();
            }
        });

        mcpProcess.stderr.on('data', (data) => {
            console.error('MCP stderr:', data.toString());
        });

        mcpProcess.on('close', (code) => {
            console.log(`MCP process exited with code ${code}`);
            mcpReady = false;
        });

        mcpProcess.on('error', (error) => {
            console.error('MCP process error:', error);
            reject(error);
        });

        // Timeout after 30 seconds
        setTimeout(() => {
            if (!mcpReady) {
                reject(new Error('MCP server initialization timeout'));
            }
        }, 30000);
    });
}

// Send message to MCP and get response
function sendToMCP(message) {
    return new Promise((resolve, reject) => {
        if (!mcpProcess || !mcpReady) {
            reject(new Error('MCP server not ready'));
            return;
        }

        let responseData = '';

        const onData = (data) => {
            responseData += data.toString();
            try {
                const response = JSON.parse(responseData);
                mcpProcess.stdout.removeListener('data', onData);
                resolve(response);
            } catch (e) {
                // Continue collecting data
            }
        };

        mcpProcess.stdout.on('data', onData);
        mcpProcess.stdin.write(JSON.stringify(message) + '\n');

        // Timeout after 10 seconds
        setTimeout(() => {
            mcpProcess.stdout.removeListener('data', onData);
            reject(new Error('MCP response timeout'));
        }, 10000);
    });
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        mcpReady: mcpReady,
        timestamp: new Date().toISOString()
    });
});

// MCP proxy endpoint
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
            id: Date.now(),
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

// List available tools endpoint
app.get('/tools', async (req, res) => {
    try {
        const response = await sendToMCP({
            jsonrpc: '2.0',
            id: Date.now(),
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

// Execute tool endpoint
app.post('/tools/:toolName', async (req, res) => {
    try {
        const { toolName } = req.params;
        const { arguments: toolArgs } = req.body;

        const response = await sendToMCP({
            jsonrpc: '2.0',
            id: Date.now(),
            method: 'tools/call',
            params: {
                name: toolName,
                arguments: toolArgs || {}
            }
        });
        res.json(response);
    } catch (error) {
        console.error('Tool execution error:', error);
        res.status(500).json({
            error: 'Failed to execute tool',
            message: error.message
        });
    }
});

// Start server
async function startServer() {
    try {
        console.log('Initializing MCP server...');
        await initializeMCP();
        console.log('MCP server ready!');

        app.listen(port, () => {
            console.log(`Dynatrace MCP Proxy server running on port ${port}`);
            console.log(`Health check: http://localhost:${port}/health`);
            console.log(`MCP endpoint: http://localhost:${port}/mcp`);
            console.log(`Tools list: http://localhost:${port}/tools`);
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
        mcpProcess.kill();
    }
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down gracefully');
    if (mcpProcess) {
        mcpProcess.kill();
    }
    process.exit(0);
});

startServer();