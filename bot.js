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

  const rawUrl = (text.match(/https?:\/\/[^\s]+/) || [""])[0];
        const idMatch = rawUrl.match(/(?:shorts\/|v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
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

        await sock.sendMessage(
          remoteJid,
          { video: videoBuffer, mimetype: "video/mp4", caption: `🎬 ${title}` },
          { quoted: msg }
        );
      } catch (err) {
        const detail = (err.stderr || err.message || "").split("\n").filter(Boolean).slice(-2).join(" ");
        await sock.sendMessage(remoteJid, { text: `❌ Download failed: ${detail}` }, { quoted: msg });
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
