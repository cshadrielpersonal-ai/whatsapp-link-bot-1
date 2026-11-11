process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import { 
  makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason, 
  Browsers, 
  makeCacheableSignalKeyStore 
} from "@whiskeysockets/baileys";
import { GoogleGenAI } from "@google/genai";
import pino from "pino";
import readline from "readline";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import "dotenv/config";

const execFileAsync = promisify(execFile);

process.on("uncaughtException", (err) => {
  console.log("[System Notice]:", err.message || err);
});
process.on("unhandledRejection", (reason) => {
  console.log("[System Notice]:", reason?.message || reason);
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const logger = pino({ level: "error" });

const chatHistory = new Map();
const MAX_HISTORY = 6;
const MAX_DURATION_SECONDS = 9000;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

function isValidYouTubeUrl(url) {
  return /^(https?:\/\/)?(www\.|m\.)?(youtube\.com|youtu\.be)\/.+$/.test(url);
}

async function downloadYouTubeVideo(youtubeUrl) {
  const tempFile = path.resolve("./temp_" + Date.now() + ".mp4");
  const cookiePath = path.resolve("./cookies.txt");

  const baseArgs = ["--no-playlist", "--no-warnings"];
  if (fs.existsSync(cookiePath)) {
    baseArgs.push("--cookies", cookiePath);
  }

  let isLongVideo = false;
  try {
    const { stdout } = await execFileAsync("yt-dlp", [...baseArgs, "--print", "duration", youtubeUrl], { timeout: 30000 });
    const duration = parseFloat(stdout.trim());
    if (!isNaN(duration)) {
      if (duration > MAX_DURATION_SECONDS) {
        const hours = (duration / 3600).toFixed(1);
        throw new Error("Video is too long (" + hours + " hours). Limit is 2.5 hours.");
      }
      if (duration > 600) {
        isLongVideo = true;
      }
    }
  } catch (err) {
    if (err.message.includes("too long")) throw err;
  }

  const qualityTarget = isLongVideo ? "res:360,fps:30" : "res:720,fps:30";

  const args = [
    ...baseArgs,
    "-f", "bv*+ba/b",
    "-S", qualityTarget,
    "--recode-video", "mp4",
    "-o", tempFile,
    youtubeUrl
  ];

  await execFileAsync("yt-dlp", args, { timeout: 1200000 });

  if (!fs.existsSync(tempFile)) {
    throw new Error("Downloaded file not found.");
  }

  return { tempFile, isLongVideo };
}

async function askAI(chatId, prompt) {
  try {
    if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
    const history = chatHistory.get(chatId);

    history.push({ role: "user", parts: [{ text: prompt }] });

    const apiKey = process.env.GEMINI_API_KEY;
    const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=" + apiKey;

    const payload = JSON.stringify({
      contents: history,
      generationConfig: {
        maxOutputTokens: 400
      }
    });

    const response = await new Promise((resolve, reject) => {
      const child = execFile("curl", [
        "-s",
        "-m", "30",
        "-X", "POST",
        endpoint,
        "-H", "Content-Type: application/json",
        "--data-binary", "@-"
      ], (error, stdout, stderr) => {
        if (error && !stdout) return reject(error);
        resolve(stdout);
      });

      child.stdin.write(payload);
      child.stdin.end();
    });

    if (!response || !response.trim()) {
      return "⚠️ Request timed out. Please try again.";
    }

    const data = JSON.parse(response);

    if (data.error) {
      console.error("[AI Error API]:", data.error.message || JSON.stringify(data.error));
      return "⚠️ " + (data.error.message || "API error.");
    }

    const candidate = data.candidates?.[0]?.content?.parts;
    let replyText = "";
    if (Array.isArray(candidate)) {
      replyText = candidate.map(p => p.text || "").join("").trim();
    }

    if (!replyText) replyText = "No response generated.";

    history.push({ role: "model", parts: [{ text: replyText }] });

    if (history.length > MAX_HISTORY) {
      chatHistory.set(chatId, history.slice(-MAX_HISTORY));
    }

    return replyText;
  } catch (err) {
    console.error("[AI Error]:", err.message || err);
    return "Server busy. Please try again.";
  }
}

const MENU_TEXT = `╭─〔 Shiroine 〕
│ User: Hadriel
│ Status: Active
│ Engine: Authenticated yt-dlp + Gemini AI
╰──────────

╭─〔 DOWNLOADER 〕
│ .shorts <youtube_url>
│ .ytmp4 <youtube_url>
╰──────────
╭─〔 UTILITIES 〕
│ .del / .delete (Reply to message)
│ .ai <prompt>
│ .reset (Clear Memory)
│ .ping
│ .menu
╰──────────`;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./session_auth");

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger: logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome"),
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    retryRequestDelayMs: 250,
  });

  if (!sock.authState.creds.registered) {
    const rawNumber = await question("\nEnter your WhatsApp phone number with country code (e.g. 919876543210): ");
    const phoneNumber = rawNumber.replace(/[^0-9]/g, "");
    
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        const formattedCode = code?.match(/.{1,4}/g)?.join("-") || code;
        console.log("\n=================================");
        console.log("YOUR PAIRING CODE IS:", formattedCode);
        console.log("=================================\n");
      } catch (err) {
        console.error("Failed to get pairing code:", err.message);
      }
    }, 3000);
  }

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "connecting") {
      console.log("[Status] Connecting...");
    }
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode !== DisconnectReason.loggedOut) {
        console.log("Reconnecting in 3s...");
        setTimeout(() => startBot(), 3000);
      } else {
        console.log("[Status] Logged out. Delete session_auth and run again.");
      }
    } else if (connection === "open") {
      console.log("\n[ONLINE] Bot ready with .delete command!\n");
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        "";

            if (!text) continue;

      const cleanText = text.trim();
      if (!cleanText.startsWith(".ai")) continue;

      const remoteJid = msg.key.remoteJid;
      const query = cleanText.slice(3).trim();

      if (!query) {
        await sock.sendMessage(remoteJid, { text: "Please provide a prompt!\nExample: .ai what is python?" }, { quoted: msg });
        continue;
      }

      const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
      const quotedMsg = contextInfo?.quotedMessage;
      const quotedText = quotedMsg?.conversation || quotedMsg?.extendedTextMessage?.text || "";

      let fullPrompt = query;
      if (quotedText) {
        fullPrompt = `[Context: "${quotedText}"]\nInput: ${query}`;
      }

      const reply = await askAI(remoteJid, fullPrompt);
      await sock.sendMessage(remoteJid, { text: reply }, { quoted: msg });
      continue;
    }
  });
}

startBot();
