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

  async function callGeminiVision(apiKey, mimeType, base64Data, promptText) {
  let models = ["gemini-3.8-flash", "gemini-3.8-flash-lite"];
  try {
    const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
      signal: AbortSignal.timeout(5000)
    });
    if (listRes.ok) {
      const listData = await listRes.json();
      const valid = (listData.models || [])
        .filter(m =>
          m.supportedGenerationMethods?.includes("generateContent") &&
          /gemini-(3\.8|2\.5)-flash/i.test(m.name) &&
          !/image|tts|audio|live|thinking/i.test(m.name)
        )
        .map(m => m.name.replace("models/", ""));
      if (valid.length) models = [...new Set([...models, ...valid])].slice(0, 3);
    }
  } catch (_) {}

  let lastErr = "Gemini vision request failed.";
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(10000),
          body: JSON.stringify({
            contents: [{
              parts: [
                { inlineData: { mimeType, data: base64Data } },
                { text: promptText }
              ]
            }]
          })
        });
        const data = await res.json();
        if (res.ok) {
          const out = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim();
          if (out) return out;
        }
        const msg = data.error?.message || `HTTP ${res.status}`;
        if (res.status === 404) break;
        lastErr = msg;
        if (res.status === 503 || res.status === 429 || msg.toLowerCase().includes("high demand")) {
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
        break;
      } catch (e) {
        lastErr = e.message;
      }
    }
  }
  throw new Error(lastErr);
}

async function callGeminiVision(apiKey, mimeType, base64Data, promptText) {
  const models = ["gemini-3.8-flash", "gemini-3.8-flash-lite", "gemini-3.0-flash"];
  let lastErr = "Gemini vision request failed.";
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{
              parts: [
                { inlineData: { mimeType, data: base64Data } },
                { text: promptText }
              ]
            }]
          })
        });
        const data = await res.json();
        if (res.ok) {
          const out = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim();
          if (out) return out;
        }
        lastErr = data.error?.message || `HTTP ${res.status}`;
        if (res.status === 503 || res.status === 429 || lastErr.toLowerCase().includes("high demand")) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        break;
      } catch (e) {
        lastErr = e.message;
      }
    }
  }
  throw new Error(lastErr);
}

sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      const unwrap = (m) => {
        if (!m) return {};
        if (m.ephemeralMessage?.message) return unwrap(m.ephemeralMessage.message);
        if (m.viewOnceMessage?.message) return unwrap(m.viewOnceMessage.message);
        if (m.viewOnceMessageV2?.message) return unwrap(m.viewOnceMessageV2.message);
        if (m.documentWithCaptionMessage?.message) return unwrap(m.documentWithCaptionMessage.message);
        return m;
      };
      const innerMsg = unwrap(msg.message);
      const text =
        innerMsg?.conversation ||
        innerMsg?.extendedTextMessage?.text ||
        innerMsg?.imageMessage?.caption ||
        "";

            if (!text) continue;

      const cleanText = text.trim();
      const lowerText = cleanText.toLowerCase();
      const remoteJid = msg.key.remoteJid;

      // 1. .menu command
      if (lowerText === ".menu") {
        const menuText = `🤖 *SHIROINE AI BOT MENU* 🤖

• *.ai <question>* — Ask Gemini AI anything
• *.ai <question>* (on/reply to photo) — Describe or analyze a photo
• *.draw <description>* — Generate or edit an image (reply to photo to edit)
• *.cartoon* (on/reply to photo) — Turn any photo into cartoon style
• *.reset* — Clear AI chat memory
• *.del* (reply) — Delete a bot message
• *.ping* — Check bot status
• *.menu* — Show this command list`;
        await sock.sendMessage(remoteJid, { text: menuText }, { quoted: msg });
        continue;
      }

      // 2A. .draw <description> command (Supports both new generation & photo editing)
      if (lowerText.startsWith(".draw")) {
        const prompt = cleanText.slice(5).trim();
        if (!prompt) {
          await sock.sendMessage(remoteJid, { text: "⚠️ Describe what to draw or how to edit a replied photo.\nExample: *.draw a futuristic city at sunset*\nOr reply to a photo: *.draw change background to a garden*" }, { quoted: msg });
          continue;
        }
        const quoted = unwrap(innerMsg?.extendedTextMessage?.contextInfo?.quotedMessage);
        const imgMsg = innerMsg?.imageMessage || quoted?.imageMessage;

        await sock.sendMessage(remoteJid, { text: imgMsg ? "🎨 Editing your photo, please wait..." : "🎨 Creating your image, please wait..." }, { quoted: msg });
        try {
          let finalPrompt = prompt;

          // If replying to or attaching a photo, use Gemini Vision to combine photo details + edit request
          if (imgMsg) {
            const { downloadContentFromMessage } = await import("@whiskeysockets/baileys");
            const stream = await downloadContentFromMessage(imgMsg, "image");
            const chunks = [];
            await Promise.race([
              (async () => {
                for await (const chunk of stream) chunks.push(chunk);
              })(),
              new Promise((_, rej) => setTimeout(() => rej(new Error("WhatsApp image download timed out.")), 15000))
            ]);
            const buffer = Buffer.concat(chunks);
            if (!buffer.length) throw new Error("Could not download the replied photo. Try resending the photo and replying again.");
            const mimeType = imgMsg.mimetype || "image/jpeg";
            const apiKey = process.env.GEMINI_API_KEY;

            finalPrompt = await callGeminiVision(
              apiKey,
              mimeType,
              buffer.toString("base64"),
              `Look at this photo and apply this edit instruction: "${prompt}". Write a single concise 45-word image generation prompt describing the exact same person/subject, appearance, clothing, and pose from the photo, but with the requested edit applied. Output ONLY the final image prompt.`
            );
          }

          let imgBuffer = null;
          for (const model of ["flux", "turbo"]) {
            for (let retry = 0; retry < 2; retry++) {
              try {
                const seed = Math.floor(Math.random() * 1000000);
                const imgUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(finalPrompt)}?width=1024&height=1024&seed=${seed}&model=${model}&nologo=true`;
                const res = await fetch(imgUrl, { signal: AbortSignal.timeout(25000) });
                if (res.ok) {
                  const candidate = Buffer.from(await res.arrayBuffer());
                  if (candidate.length > 2000) {
                    imgBuffer = candidate;
                    break;
                  }
                }
                if (res.status === 429 || res.status === 503) {
                  await new Promise(r => setTimeout(r, 3000));
                }
              } catch (_) {}
            }
            if (imgBuffer) break;
          }
          if (!imgBuffer) throw new Error("Image generator is busy due to rapid requests. Wait 10 seconds and try again.");

          await sock.sendMessage(remoteJid, { image: imgBuffer, caption: `🎨 *${prompt}*` }, { quoted: msg });
        } catch (err) {
          await sock.sendMessage(remoteJid, { text: `❌ Drawing failed: ${err.message}` }, { quoted: msg });
        }
        continue;
      }

      // 2B. .cartoon command (With download timeout & flux/turbo renderer fallback)
      if (lowerText.startsWith(".cartoon")) {
        const quoted = unwrap(innerMsg?.extendedTextMessage?.contextInfo?.quotedMessage);
        const imgMsg = innerMsg?.imageMessage || quoted?.imageMessage;
        if (!imgMsg) {
          await sock.sendMessage(remoteJid, { text: "⚠️ Reply to any photo with *.cartoon* (or send a photo with *.cartoon* as caption)!" }, { quoted: msg });
          continue;
        }
        await sock.sendMessage(remoteJid, { text: "✨ Turning photo into cartoon style, please wait..." }, { quoted: msg });
        try {
          console.log("[CARTOON] Downloading image from WhatsApp...");
          const { downloadContentFromMessage } = await import("@whiskeysockets/baileys");
          const stream = await downloadContentFromMessage(imgMsg, "image");
          const chunks = [];
          await Promise.race([
            (async () => {
              for await (const chunk of stream) chunks.push(chunk);
            })(),
            new Promise((_, rej) => setTimeout(() => rej(new Error("WhatsApp image download timed out. Try resending the photo.")), 15000))
          ]);
          const buffer = Buffer.concat(chunks);
          if (!buffer.length) throw new Error("Downloaded image was empty.");

          const mimeType = imgMsg.mimetype || "image/jpeg";
          const apiKey = process.env.GEMINI_API_KEY;

          console.log("[CARTOON] Analyzing image with Gemini...");
          const sceneDesc = await callGeminiVision(
            apiKey,
            mimeType,
            buffer.toString("base64"),
            "Write a concise 40-word visual image prompt describing the exact subject, face/hair/clothing, pose, colors, and background in this photo so an artist can draw it in vibrant 2D cartoon anime style. Output ONLY the prompt."
          );
          console.log("[CARTOON] Prompt:", sceneDesc);

          const cartoonPrompt = `vibrant colorful 2D cartoon anime illustration, clean bold outlines, studio anime shading, ${sceneDesc}`;
          let imgBuffer = null;
          for (const model of ["flux", "turbo"]) {
            try {
              const seed = Math.floor(Math.random() * 1000000);
              const imgUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(cartoonPrompt)}?width=1024&height=1024&seed=${seed}&model=${model}&nologo=true`;
              const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(25000) });
              if (imgRes.ok) {
                const candidate = Buffer.from(await imgRes.arrayBuffer());
                if (candidate.length > 2000) {
                  imgBuffer = candidate;
                  break;
                }
              }
            } catch (e) {
              console.log(`[CARTOON] Model ${model} failed:`, e.message);
            }
          }
          if (!imgBuffer) throw new Error("Cartoon image renderer timed out. Please try again.");

          await sock.sendMessage(remoteJid, { image: imgBuffer, caption: "✨ *Cartoon Style Applied!*" }, { quoted: msg });
        } catch (err) {
          console.error("[CARTOON] Error:", err.message);
          await sock.sendMessage(remoteJid, { text: `❌ Cartoon edit failed: ${err.message}` }, { quoted: msg });
        }
        continue;
      }

      // 2C. .ai with an attached or replied-to photo (describe/analyze image)
      if (lowerText.startsWith(".ai")) {
        const quoted = unwrap(innerMsg?.extendedTextMessage?.contextInfo?.quotedMessage);
        const imgMsg = innerMsg?.imageMessage || quoted?.imageMessage;
        if (imgMsg) {
          const questionText = cleanText.slice(3).trim() || "Describe this photo in detail.";
          try {
            const { downloadContentFromMessage } = await import("@whiskeysockets/baileys");
            const stream = await downloadContentFromMessage(imgMsg, "image");
            let buffer = Buffer.alloc(0);
            for await (const chunk of stream) {
              buffer = Buffer.concat([buffer, chunk]);
            }
            const mimeType = imgMsg.mimetype || "image/jpeg";
            const apiKey = process.env.GEMINI_API_KEY;
            const reply = await callGeminiVision(apiKey, mimeType, buffer.toString("base64"), questionText);
            await sock.sendMessage(remoteJid, { text: reply }, { quoted: msg });
          } catch (err) {
            await sock.sendMessage(remoteJid, { text: `❌ Image analysis failed: ${err.message}` }, { quoted: msg });
          }
          continue;
        }
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
