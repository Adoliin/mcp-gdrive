import { google } from "googleapis";
import { GDriveReadFileInput, InternalToolResponse } from "./types.js";

export const schema = {
  name: "gdrive_read_file",
  description: "Read contents of a file from Google Drive",
  inputSchema: {
    type: "object",
    properties: {
      fileId: {
        type: "string",
        description: "ID of the file to read",
      },
    },
    required: ["fileId"],
  },
} as const;

interface FileContent {
  uri?: string;
  mimeType: string;
  text?: string;
  blob?: string;
}

export async function readFile(
  args: GDriveReadFileInput,
): Promise<InternalToolResponse> {
  try {
    const result = await readGoogleDriveFile(args.fileId);
    return {
      content: [
        {
          type: "text",
          text: `Contents of ${result.name}:\n\n${result.contents.text || result.contents.blob}`,
        },
      ],
      isError: false,
    };
  } catch (error: any) {
    console.error(`Error reading file ${args.fileId}:`, error);
    return {
      content: [
        {
          type: "text",
          text: `Error reading file: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
}

async function readGoogleDriveFile(
  fileId: string,
): Promise<{ name: string; contents: FileContent }> {
  // Initialize the drive client inside the function
  // This ensures it uses the current authentication context
  const drive = google.drive("v3");

  // First get file metadata to check mime type
  // Adding parameters to support service account access to shared drives
  const file = await drive.files.get({
    fileId,
    fields: "mimeType,name,parents,driveId",
    supportsAllDrives: true
  });

console.log(`File metadata for ${fileId}:`, JSON.stringify(file.data, null, 2));

// For Google Docs/Sheets/etc we need to export
if (file.data.mimeType?.startsWith("application/vnd.google-apps")) {
  let exportMimeType: string;
  switch (file.data.mimeType) {
    case "application/vnd.google-apps.document":
      exportMimeType = "text/markdown";
      break;
    case "application/vnd.google-apps.spreadsheet":
      exportMimeType = "text/csv";
      break;
    case "application/vnd.google-apps.presentation":
      exportMimeType = "text/plain";
      break;
    case "application/vnd.google-apps.drawing":
      exportMimeType = "image/png";
      break;
    default:
      exportMimeType = "text/plain";
  }

  // Export the Google Workspace file
  const res = await drive.files.export({
    fileId,
    mimeType: exportMimeType,
  }, {
    responseType: "text"
  });

  return {
    name: file.data.name || fileId,
    contents: {
      mimeType: exportMimeType,
      text: res.data as string,
    },
  };
}

// For regular files download content
const res = await drive.files.get({
  fileId,
  alt: "media",
  supportsAllDrives: true,
}, {
  responseType: "arraybuffer"
});

const mimeType = file.data.mimeType || "application/octet-stream";
const isText = mimeType.startsWith("text/") || mimeType === "application/json";
const content = Buffer.from(res.data as ArrayBuffer);

return {
  name: file.data.name || fileId,
  contents: {
    mimeType,
    ...(isText
      ? { text: content.toString("utf-8") }
      : { blob: content.toString("base64") }),
  },
};
}

