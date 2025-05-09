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

function truncateBase64Content(text: string): string {
  if (!text) return text;

  // Regex to find base64 image data in markdown or other formats
  // This pattern looks for common base64 data patterns like:
  // 1. <data:image/png;base64,...> format
  // 2. base64,... format in various contexts
  const base64Patterns = [
    // Match markdown image links with base64 data
    /\[.*?\]: <(data:image\/[^;]+;base64,[A-Za-z0-9+/=]{50,})>/g,
    // Match HTML/XML img tags with base64 src
    /<img[^>]*src="(data:image\/[^;]+;base64,[A-Za-z0-9+/=]{50,})"[^>]*>/g,
    // Match general base64 data URIs
    /(data:image\/[^;]+;base64,[A-Za-z0-9+/=]{50,})/g,
    // Match other potential base64 content (generic)
    /(base64,[A-Za-z0-9+/=]{50,})/g
  ];

  let processedText = text;

  // Replace each pattern with a truncated version
  for (const pattern of base64Patterns) {
    processedText = processedText.replace(pattern, (match, base64Part) => {
      // Extract the mime type if present
      const mimeMatch = base64Part.match(/data:(image\/[^;]+);/);
      const mimeType = mimeMatch ? mimeMatch[1] : "binary data";

      // For markdown image links
      if (match.startsWith('[') && match.includes(']: <')) {
        return match.replace(base64Part, `data:${mimeType};base64,[BASE64_DATA_TRUNCATED]`);
      }

      // For HTML img tags
      if (match.startsWith('<img')) {
        return match.replace(base64Part, `data:${mimeType};base64,[BASE64_DATA_TRUNCATED]`);
      }

      // For other formats
      return base64Part.substring(0, 20) + "[BASE64_DATA_TRUNCATED]";
    });
  }

  return processedText;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + " bytes";
  else if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  else if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  else return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
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
          text: `Contents of ${result.name}:\n\n${result.contents.text ?
            truncateBase64Content(result.contents.text) :
            (result.contents.blob ? '[BINARY_DATA_TRUNCATED]' : 'No content available')}`,
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
      text: truncateBase64Content(res.data as string),
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
      ? { text: truncateBase64Content(content.toString("utf-8")) }
      : { blob: `[BINARY_DATA_TRUNCATED - ${formatFileSize(content.length)}]` }),
  },
};
}

