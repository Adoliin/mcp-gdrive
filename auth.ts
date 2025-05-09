import { authenticate } from "@google-cloud/local-auth";
import { google } from "googleapis";
import fs from "fs";
import path from "path";

export const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/spreadsheets",
];

// Authentication types
export enum AuthType {
  OAUTH = "oauth",
  SERVICE_ACCOUNT = "service_account"
}

// Get credentials directory from environment variable or use default
const CREDS_DIR =
  process.env.GDRIVE_CREDS_DIR ||
  path.join(path.dirname(new URL(import.meta.url).pathname), "../../../");

// Service account file path
const serviceAccountPath = process.env.GDRIVE_SERVICE_ACCOUNT_PATH ||
  path.join(CREDS_DIR, "service-account.json");


// Ensure the credentials directory exists
function ensureCredsDirectory() {
  try {
    fs.mkdirSync(CREDS_DIR, { recursive: true });
    console.error(`Ensured credentials directory exists at: ${CREDS_DIR}`);
  } catch (error) {
    console.error(
      `Failed to create credentials directory: ${CREDS_DIR}`,
      error,
    );
    throw error;
  }
}

// Path for OAuth credentials
const oauthCredentialsPath = path.join(CREDS_DIR, ".gdrive-server-credentials.json");

async function authenticateWithTimeout(
  keyfilePath: string,
  SCOPES: string[],
  timeoutMs = 30000,
): Promise<any | null> {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Authentication timed out")), timeoutMs),
  );

  const authPromise = authenticate({
    keyfilePath,
    scopes: SCOPES,
  });

  try {
    return await Promise.race([authPromise, timeoutPromise]);
  } catch (error) {
    console.error(error);
    return null;
  }
}

async function authenticateAndSaveCredentials() {
  console.error("Launching auth flow…");
  console.error("Using credentials path:", oauthCredentialsPath);

  const keyfilePath = path.join(CREDS_DIR, "gcp-oauth.keys.json");
  console.error("Using keyfile path:", keyfilePath);

  const auth = await authenticateWithTimeout(keyfilePath, SCOPES);
  if (auth) {
    const newAuth = new google.auth.OAuth2();
    newAuth.setCredentials(auth.credentials);
  }

  try {
    const { credentials } = await auth.refreshAccessToken();
    console.error("Received new credentials with scopes:", credentials.scope);

    // Ensure directory exists before saving
    ensureCredsDirectory();

    fs.writeFileSync(oauthCredentialsPath, JSON.stringify(credentials, null, 2));
    console.error(
      "Credentials saved successfully with refresh token to:",
      oauthCredentialsPath,
    );
    auth.setCredentials(credentials);
    return auth;
  } catch (error) {
    console.error("Error refreshing token during initial auth:", error);
    return auth;
  }
}

// Determine which authentication method to use
export function getAuthType(): AuthType {
  // Use service account if explicitly set in environment variable
  if (process.env.USE_SERVICE_ACCOUNT === "true") {
    return AuthType.SERVICE_ACCOUNT;
  }

  // Use service account if the file exists and no OAuth credentials exist
  if (fs.existsSync(serviceAccountPath) && !fs.existsSync(oauthCredentialsPath)) {
    return AuthType.SERVICE_ACCOUNT;
  }

  // Default to OAuth
  return AuthType.OAUTH;
}

// Authenticate with service account
export async function authenticateWithServiceAccount() {
  console.error("Authenticating with service account from:", serviceAccountPath);

  if (!fs.existsSync(serviceAccountPath)) {
    console.error("Service account file not found at:", serviceAccountPath);
    return null;
  }

  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: serviceAccountPath,
      scopes: SCOPES,
    });

    console.error("Service account authentication successful");
    return auth;
  } catch (error) {
    console.error("Error authenticating with service account:", error);
    return null;
  }
}

// Try to load OAuth credentials without prompting for auth
export async function loadOAuthCredentialsQuietly() {
  console.error("Attempting to load OAuth credentials from:", oauthCredentialsPath);

  const oauth2Client = new google.auth.OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
  );

  if (!fs.existsSync(oauthCredentialsPath)) {
    console.error("No OAuth credentials file found");
    return null;
  }

  try {
    const savedCreds = JSON.parse(fs.readFileSync(oauthCredentialsPath, "utf-8"));
    console.error("Loaded existing OAuth credentials with scopes:", savedCreds.scope);
    oauth2Client.setCredentials(savedCreds);

    const expiryDate = new Date(savedCreds.expiry_date);
    const now = new Date();
    const fiveMinutes = 5 * 60 * 1000;
    const timeToExpiry = expiryDate.getTime() - now.getTime();

    console.error("Token expiry status:", {
      expiryDate: expiryDate.toISOString(),
      timeToExpiryMinutes: Math.floor(timeToExpiry / (60 * 1000)),
      hasRefreshToken: !!savedCreds.refresh_token,
    });

    if (timeToExpiry < fiveMinutes && savedCreds.refresh_token) {
      console.error("Attempting to refresh token using refresh_token");
      try {
        const response = await oauth2Client.refreshAccessToken();
        const newCreds = response.credentials;
        ensureCredsDirectory();
        fs.writeFileSync(oauthCredentialsPath, JSON.stringify(newCreds, null, 2));
        oauth2Client.setCredentials(newCreds);
        console.error("Token refreshed and saved successfully");
      } catch (error) {
        console.error("Failed to refresh token:", error);
        return null;
      }
    }

    return oauth2Client;
  } catch (error) {
    console.error("Error loading OAuth credentials:", error);
    return null;
  }
}

// Try to load credentials based on the configured auth type
export async function loadCredentialsQuietly() {
  const authType = getAuthType();
  console.error(`Using auth type: ${authType}`);

  if (authType === AuthType.SERVICE_ACCOUNT) {
    return await authenticateWithServiceAccount();
  } else {
    return await loadOAuthCredentialsQuietly();
  }
}

// Get valid credentials, prompting for auth if necessary
export async function getValidCredentials(forceAuth = false) {
  // First try to load credentials silently
  if (!forceAuth) {
    const quietAuth = await loadCredentialsQuietly();
    if (quietAuth) {
      return quietAuth;
    }
  }

  // If we're using service account authentication, try again to authenticate
  if (getAuthType() === AuthType.SERVICE_ACCOUNT) {
    console.error("Retrying service account authentication");
    return await authenticateWithServiceAccount();
  }

  // Fall back to OAuth user authentication
  return await authenticateAndSaveCredentials();
}

// Background refresh that never prompts for auth
export function setupTokenRefresh() {
  console.error("Setting up automatic token refresh interval (45 minutes)");
  return setInterval(
    async () => {
      try {
        console.error("Running scheduled token refresh check");
        const auth = await loadCredentialsQuietly();
        if (auth) {
          google.options({ auth });
          console.error("Completed scheduled token refresh");
        } else {
          console.error("Skipping token refresh - no valid credentials");
        }
      } catch (error) {
        console.error("Error in automatic token refresh:", error);
      }
    },
    45 * 60 * 1000,
  );
}
