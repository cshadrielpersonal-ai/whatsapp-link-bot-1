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
  const idMatch = youtubeUrl.match(/(?:shorts\/|v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (!idMatch) throw new Error("Invalid YouTube link.");
  const videoId = idMatch[1];

  let streamUrl = null;
        let title = "YouTube Short";

        const clients = [
          {
            name: "ANDROID_VR",
            userAgent: "com.google.android.apps.youtube.vr.oculus/1.56.21 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
            context: { client: { clientName: "ANDROID_VR", clientVersion: "1.56.21", androidSdkVersion: 32, osName: "Android", osVersion: "12L", hl: "en", gl: "US" } }
          },
          {
            name: "IOS",
            userAgent: "com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)",
            context: { client: { clientName: "IOS", clientVersion: "19.29.1", deviceMake: "Apple", deviceModel: "iPhone16,2", osName: "iPhone", osVersion: "17.5.1.21F90", hl: "en", gl: "US" } }
          }
        ];

        for (const c of clients) {
          try {
            const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "User-Agent": c.userAgent,
                "X-YouTube-Client-Name": c.name === "IOS" ? "5" : "28",
                "X-YouTube-Client-Version": c.context.client.clientVersion
              },
              body: JSON.stringify({ videoId, context: c.context }),
              signal: AbortSignal.timeout(10000)
            });
            if (!res.ok) continue;
            const data = await res.json();
            title = data.videoDetails?.title || title;
            const formats = [
              ...(data.streamingData?.formats || []),
              ...(data.streamingData?.adaptiveFormats || [])
            ];
            // Pick progressive MP4 with both audio & video (itag 18 = 360p mp4, itag 22 = 720p mp4)
            const mp4 = (data.streamingData?.formats || []).find(f => f.mimeType?.includes("video/mp4") && f.url)
                     || formats.find(f => f.mimeType?.includes("video/mp4") && f.audioQuality && f.url);
            if (mp4?.url) {
              streamUrl = mp4.url;
              break;
            }
          } catch (_) {}
        }

        if (!streamUrl) {
          throw new Error("Could not extract video stream. Try another link.");
        }

  const vidRes = await fetch(streamUrl, { signal: AbortSignal.timeout(25000) });
  if (!vidRes.ok) throw new Error(`Stream download failed (${vidRes.status})`);
  fs.writeFileSync(tempFile, Buffer.from(await vidRes.arrayBuffer()));

  return { tempFile, isLongVideo: false };
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
      const lowerText = cleanText.toLowerCase();
      const remoteJid = msg.key.remoteJid;

      // 1. .menu command
      if (lowerText === ".menu") {
        const menuText = `🤖 *WHATSAPP AI BOT MENU* 🤖

• *.ai <question>* — Ask Gemini AI anything
• *.shorts <youtube-link>* — Download any YouTube video or Short
• *.menu* — Show this command list`;
        await sock.sendMessage(remoteJid, { text: menuText }, { quoted: msg });
        continue;
      }

      // 2. .shorts <youtube-link> command
      if (lowerText.startsWith(".shorts")) {
        const url = cleanText.slice(7).trim();
        if (!url || (!url.includes("youtube.com") && !url.includes("youtu.be"))) {
          await sock.sendMessage(remoteJid, { text: "❌ Please send a valid YouTube link.\nExample: *.shorts https://youtube.com/shorts/...*" }, { quoted: msg });
          continue;
        }

        await sock.sendMessage(remoteJid, { text: "⏳ Downloading video, please wait..." }, { quoted: msg });
        const outFile = `/tmp/yt_${Date.now()}.mp4`;

        try {
          const ytUrl = (text.match(/https?:\/\/[^\s]+/) || [""])[0];
          const args = [
            "--no-playlist",
            "--no-warnings",
            "--max-filesize", "40M",
            "-f", "18/b[ext=mp4][height<=480]/b[ext=mp4]",
            "-o", outFile
          ];
          if (fs.existsSync("./cookies.txt")) {
            args.push("--cookies", "./cookies.txt");
          }
          args.push(ytUrl);

          await new Promise((resolve, reject) => {
            execFile("yt-dlp", args, { timeout: 45000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
              if (err) {
                err.stderr = stderr;
                reject(err);
              } else {
                resolve(stdout);
              }
            });
          });

          await sock.sendMessage(
            remoteJid,
            { video: fs.readFileSync(outFile), mimetype: "video/mp4", caption: "🎬 Downloaded via Shiroine" },
            { quoted: msg }
          );
          if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
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
