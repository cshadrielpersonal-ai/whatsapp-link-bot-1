import { execSync } from "child_process";
import http from 'http';

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WhatsApp AI Bot is Online!\n');
}).listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Listening on port ${PORT}`);
});
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import { 
  makeWASocket,
  fetchLatestBaileysVersion, 
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

if (process.env.YT_COOKIES && !fs.existsSync("./cookies.txt")) {
  console.log("[Setup] Restoring cookies.txt from YT_COOKIES...");
  fs.writeFileSync("./cookies.txt", Buffer.from(process.env.YT_COOKIES, "base64").toString("utf8"));
}


if (process.env.SESSION_DATA && !fs.existsSync("./session_auth/creds.json")) {
  console.log("[Setup] Restoring WhatsApp session from SESSION_DATA...");
  fs.writeFileSync("session.tar.gz", Buffer.from(process.env.SESSION_DATA, "base64"));
  execSync("tar -xzf session.tar.gz");
}

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
  const idMatch = youtubeUrl.match(/(?:shorts\/|v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (!idMatch) throw new Error("Invalid YouTube link.");
  const videoId = idMatch[1];

  const pipedInstances = [
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.tokhmi.xyz",
    "https://pipedapi.moomoo.me",
    "https://api.piped.projectsegfau.lt"
  ];

  let streamUrl = null;
  let title = "YouTube Short";

  for (const base of pipedInstances) {
    try {
      const res = await fetch(`${base}/streams/${videoId}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const data = await res.json();
      title = data.title || title;
      const mp4 = (data.videoStreams || []).find(s => !s.videoOnly && s.format === "MPEG_4")
               || (data.videoStreams || []).find(s => !s.videoOnly);
      if (mp4 && mp4.url) {
        streamUrl = mp4.url;
        break;
      }
    } catch (_) {}
  }

  if (!streamUrl) {
    throw new Error("All video mirrors are busy right now. Try again in a moment.");
  }

  const vidRes = await fetch(streamUrl, { signal: AbortSignal.timeout(25000) });
  if (!vidRes.ok) throw new Error(`Stream download failed (${vidRes.status})`);
  const videoBuffer = Buffer.from(await vidRes.arrayBuffer());
  return { videoBuffer, title };
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info_baileys");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    auth: state,
    printQRInTerminal: false,
    browser: ["Ubuntu", "Chrome", "20.0.04"]
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "close") {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startBot();
    } else if (connection === "open") {
      console.log("✅ WhatsApp Bot Connected!");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.remoteJid === "status@broadcast") continue;

      const remoteJid = msg.key.remoteJid;
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        "";

      const cleanText = text.trim();
      const lowerText = cleanText.toLowerCase();

      if (lowerText === ".menu") {
        await sock.sendMessage(
          remoteJid,
          {
            text: "🤖 *WHATSAPP AI BOT MENU* 🤖\n\n• *.ai <question>* — Ask Gemini AI anything\n• *.shorts <youtube-link>* — Download any YouTube video or Short\n• *.menu* — Show this command list"
          },
          { quoted: msg }
        );
        continue;
      }

      if (lowerText.startsWith(".shorts")) {
        const ytUrl = (cleanText.match(/https?:\/\/[^\s]+/) || [""])[0];
        if (!ytUrl || !isValidYouTubeUrl(ytUrl)) {
          await sock.sendMessage(remoteJid, { text: "Please provide a valid YouTube link!\nExample: .shorts https://youtube.com/shorts/..." }, { quoted: msg });
          continue;
        }
        await sock.sendMessage(remoteJid, { text: "⏳ Downloading video, please wait..." }, { quoted: msg });
        try {
          const { videoBuffer, title } = await downloadYouTubeVideo(ytUrl);
          await sock.sendMessage(
            remoteJid,
            { video: videoBuffer, mimetype: "video/mp4", caption: `🎬 ${title}` },
            { quoted: msg }
          );
        } catch (err) {
          await sock.sendMessage(remoteJid, { text: `❌ Download failed: ${err.message}` }, { quoted: msg });
        }
        continue;
      }





      // 3. Only listen to .ai messages for Gemini
      if (!lowerText.startsWith(".ai")) continue;
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
