#!/usr/bin/env node
import 'dotenv/config';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { google } from "googleapis";
import {
  getValidCredentials,
  setupTokenRefresh,
  loadCredentialsQuietly,
  getAuthType,
  AuthType
} from "./auth.js";
import { tools } from "./tools/index.js";
import { InternalToolResponse } from "./tools/types.js";

const server = new Server(
  {
    name: "example-servers/gdrive",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {
        schemes: ["gdrive"], // Declare that we handle gdrive:/// URIs
        listable: true, // Support listing available resources
        readable: true, // Support reading resource contents
      },
      tools: {},
    },
  },
);

// Ensure we have valid credentials before making API calls
async function ensureAuth() {
  const auth = await getValidCredentials();
  google.options({ auth });
  return auth;
}

async function ensureAuthQuietly() {
  const auth = await loadCredentialsQuietly();
  if (auth) {
    google.options({ auth });
  }
  return auth;
}

server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
  try {
    await ensureAuthQuietly();
    // Initialize drive client inside the function to use current auth context
    const drive = google.drive("v3");

    const pageSize = 10;
    const params: any = {
      pageSize,
      fields: "nextPageToken, files(id, name, mimeType, driveId, parents)",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    };

    if (request.params?.cursor) {
      params.pageToken = request.params.cursor;
    }

    const res = await drive.files.list(params);
    const files = res.data.files!;

    return {
      resources: files.map((file) => ({
        uri: `gdrive:///${file.id}`,
        mimeType: file.mimeType,
        name: file.name,
      })),
      nextCursor: res.data.nextPageToken,
    };
  } catch (error: any) {
    console.error("Error listing resources:", error);
    throw error;
  }
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  try {
    await ensureAuthQuietly();
    const fileId = request.params.uri.replace("gdrive:///", "");
    console.log(`Attempting to read resource: ${fileId}`);

    const readFileTool = tools[1]; // gdrive_read_file is the second tool
    const result = await readFileTool.handler({ fileId });

    if (result.isError) {
      console.error(`Error reading resource ${fileId}:`, result.content[0].text);
      throw new Error(result.content[0].text);
    }

    // Extract the file contents from the tool response
    const parts = result.content[0].text.split("\n\n");
    const fileContents = parts.length > 1 ? parts.slice(1).join("\n\n") : parts[0];

    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: "text/plain", // You might want to determine this dynamically
          text: fileContents,
        },
      ],
    };
  } catch (error: any) {
    console.error(`Error in ReadResourceRequestSchema handler:`, error);
    throw error;
  }
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  };
});

// Helper function to convert internal tool response to SDK format
function convertToolResponse(response: InternalToolResponse) {
  return {
    _meta: {},
    content: response.content,
    isError: response.isError,
  };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  await ensureAuth();
  const tool = tools.find((t) => t.name === request.params.name);
  if (!tool) {
    throw new Error("Tool not found");
  }

  const result = await tool.handler(request.params.arguments as any);
  return convertToolResponse(result);
});

async function startServer() {
  try {
    console.error("Starting server");

    // Log which authentication method we're using
    const authType = getAuthType();
    console.error(`Using authentication method: ${authType}`);

    // Add this line to force authentication at startup
    await ensureAuth(); // This will trigger the auth flow if no valid credentials exist

    const transport = new StdioServerTransport();
    await server.connect(transport);

    // Set up periodic token refresh that never prompts for auth
    // (only needed for OAuth authentication)
    if (authType === AuthType.OAUTH) {
      setupTokenRefresh();
    }
  } catch (error) {
    console.error("Error starting server:", error);
    process.exit(1);
  }
}

// Start server immediately
startServer().catch(console.error);
