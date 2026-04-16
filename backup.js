import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { google } from "googleapis";
import dotenv from "dotenv";
import archiver from "archiver";
import express from "express";
import https from "https";
import { createClient } from "@supabase/supabase-js";
import cookieParser from "cookie-parser";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cookieParser());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ----------------------------
// AUTH MIDDLEWARE
// ----------------------------
function authenticate(req, res, next) {
  const token = req.cookies.auth_token;
  if (token === process.env.API_KEY) {
    return next();
  }
  res.status(401).json({ error: "Unauthorized" });
}

app.post("/verify-password", async (req, res) => {
  const { password } = req.body;

  try {
    const { data, error } = await supabase
      .from("user_master")
      .select("master_password")
      .eq("master_password", password)
      .single();

    if (error || !data) {
      return res.status(401).json({ error: "Invalid password" });
    }

    res.cookie("auth_token", process.env.API_KEY, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production"
    });

    res.json({ status: "OK" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------
// PROJECTS CONFIG
// ----------------------------
const projects = [
  {
    name: "Portfolio",
    db: {
      host: process.env.DB_HOST_PF,
      user: process.env.DB_USER_PF,
      password: process.env.DB_PASSWORD_PF,
      name: process.env.DB_NAME_PF,
      port: process.env.DB_PORT_PF
    },
    driveFolder: process.env.DRIVE_FOLDER_ID_PF,
    lastRunFile: "./last-run-pf.json"
  },
 
{
    name: "Data 360",
    db: {
      host: process.env.DB_HOST_DATA,
      user: process.env.DB_USER_DATA,
      password: process.env.DB_PASSWORD_DATA,
      name: process.env.DB_NAME_DATA,
      port: process.env.DB_PORT_DATA
    },
    driveFolder: process.env.DRIVE_FOLDER_ID_DATA,
    lastRunFile: "./last-run-data.json"
  },
 
{
    name: "Expense",
    db: {
      host: process.env.DB_HOST_EXP,
      user: process.env.DB_USER_EXP,
      password: process.env.DB_PASSWORD_EXP,
      name: process.env.DB_NAME_EXP,
      port: process.env.DB_PORT_EXP
    },
    driveFolder: process.env.DRIVE_FOLDER_ID_EXP,
    lastRunFile: "./last-run-exp.json"
  }

  // ADD MORE PROJECTS HERE
];

// ----------------------------
// FOLDERS
// ----------------------------
const TEMP_DIR = "./temp";
const LOG_DIR = "./logs";

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

// RESET LOGS ON START
const logFile = path.join(LOG_DIR, "backup.log");
fs.writeFileSync(logFile, "");

log("=== SERVER STARTED (LOG RESET) ===");

// ----------------------------
// LOGGING
// ----------------------------
function log(msg) {
  const time = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata"
  });

  const line = `[${time}] ${msg}\n`;

  console.log(line.trim());
  fs.appendFileSync(path.join(LOG_DIR, "backup.log"), line);
}

// ----------------------------
// GOOGLE AUTH
// ----------------------------
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);

oauth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN
});

const drive = google.drive({ version: "v3", auth: oauth2Client });

// ----------------------------
// DB DUMP
// ----------------------------
function createDump(connectionString, filePath) {
  return new Promise((resolve, reject) => {
    exec(`pg_dump "${connectionString}" > "${filePath}"`, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ----------------------------
// ZIP
// ----------------------------
function zipFile(source, out) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(out);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", resolve);
    archive.on("error", reject);

    archive.pipe(output);
    archive.file(source, { name: path.basename(source) });
    archive.finalize();
  });
}

// ----------------------------
// UPLOAD
// ----------------------------
async function uploadToDrive(filePath, folderId, projectName) {
  const res = await drive.files.create({
    resource: {
      name: path.basename(filePath),
      parents: [folderId]
    },
    media: {
      mimeType: "application/zip",
      body: fs.createReadStream(filePath)
    }
  });

log(`Uploaded: ${projectName}`);
}

// ----------------------------
// DELETE OLD BACKUPS (KEEP 3)
// ----------------------------
async function deleteOldBackups(folderId) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and mimeType='application/zip' and trashed=false`,
    fields: "files(id,name,createdTime)",
    orderBy: "createdTime desc"
  });

  const files = res.data.files || [];
  const KEEP_LAST = 3;

  if (files.length <= KEEP_LAST) {
    log("No old backups to delete");
    return;
  }

  const filesToDelete = files.slice(KEEP_LAST);

  for (const file of filesToDelete) {
    try {
      await drive.files.delete({ fileId: file.id });
      log(`Deleted: ${file.name}`);
    } catch (err) {
      log(`Failed to delete: ${file.name} - ${err.message}`);
    }
  }
}

// ----------------------------
// HAS BACKUPS?
// ----------------------------
async function hasBackups(folderId) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and mimeType='application/zip' and trashed=false`,
    fields: "files(id)",
    pageSize: 1
  });
  return (res.data.files || []).length > 0;
}

// ----------------------------
// RUN BACKUP (PER PROJECT)
// ----------------------------
async function runBackup(project) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");

  const sqlFile = path.join(TEMP_DIR, `${project.name}_${ts}.sql`);
  const zipFilePath = path.join(TEMP_DIR, `${project.name}_${ts}.zip`);

  const connectionString =
    `postgresql://${project.db.user}:${project.db.password}` +
    `@${project.db.host}:${project.db.port}/${project.db.name}` +
    `?sslmode=require`;

  log(`Starting backup: ${project.name}`);

  await createDump(connectionString, sqlFile);
  await zipFile(sqlFile, zipFilePath);

  await uploadToDrive(zipFilePath, project.driveFolder, project.name);
  await deleteOldBackups(project.driveFolder);

  fs.unlinkSync(sqlFile);
  fs.unlinkSync(zipFilePath);

  const time = new Date().toLocaleString("en-IN", {
  timeZone: "Asia/Kolkata"
});

log(`Completed: ${project.name}`);
sendTelegram(`✅ ${project.name} backup done at ${time}`);
}

// ----------------------------
// SCHEDULER HELPERS
// ----------------------------
function shouldRun(file) {
  if (!fs.existsSync(file)) return true;

  const data = JSON.parse(fs.readFileSync(file));
  const last = new Date(data.date);
  const now = new Date();

  return (now - last) / (1000 * 60 * 60 * 24) >= 3;
}

function markRun(file) {
  fs.writeFileSync(file, JSON.stringify({ date: new Date() }));
}

function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  const url = `https://api.telegram.org/bot${token}/sendMessage?chat_id=${chatId}&text=${encodeURIComponent(message)}`;

  https.get(url, (res) => {
    res.on("data", () => {});
  }).on("error", (err) => {
    log("Telegram Error: " + err.message);
  });
}

// ----------------------------
// MULTI-PROJECT RUNNER
// ----------------------------
let running = false;

async function checkAndRun() {
  if (running) return;
  running = true;

  try {
for (const project of projects) {
  try {
    const exists = await hasBackups(project.driveFolder);
    if (!exists || shouldRun(project.lastRunFile)) {
      if (!exists) log(`No backup found for ${project.name} on Drive. Forcing backup.`);
      await runBackup(project);
      markRun(project.lastRunFile);
    } else {
      log(`Skip ${project.name} (not 3 days yet)`);
    }
  } catch (err) {
    log(`FAILED: ${project.name} - ${err.message}`);
    
  }
}
  } catch (e) {
  log("FAILED: " + (e.stack || e.message));
  sendTelegram(`❌ Backup FAILED\n${e.message}`);
}

  running = false;
}

// ----------------------------
// API SECURITY
// ----------------------------
app.get("/health", authenticate, (req, res) => {
  res.json({
    status: "OK",
    time: new Date().toISOString(),
    projects: projects.length
  });
});

app.get("/run-backup", authenticate, async (req, res) => {
  if (running) {
    return res.status(429).json({ error: "Backup already running" });
  }

  running = true;
  const results = [];

  try {
    for (const project of projects) {
      try {
        const exists = await hasBackups(project.driveFolder);
        if (!exists || shouldRun(project.lastRunFile)) {
          if (!exists) log(`No backup found for ${project.name} on Drive. Forcing backup.`);
          await runBackup(project);
          markRun(project.lastRunFile);

          results.push({
            project: project.name,
            status: "SUCCESS"
          });
        } else {
          results.push({
            project: project.name,
            status: "SKIPPED"
          });
        }
      } catch (err) {
        log(`FAILED: ${project.name} - ${err.message}`);
        sendTelegram(`❌ ${project.name} FAILED\n${err.message}`);

        results.push({
          project: project.name,
          status: "FAILED",
          error: err.message
        });
      }
    }

    // 📦 Build summary message
    let summary = "📦 Backup Summary\n\n";

    results.forEach(r => {
      if (r.status === "SUCCESS") {
        summary += `✅ ${r.project}\n`;
      } else if (r.status === "SKIPPED") {
        summary += `⏭️ ${r.project} (Skipped)\n`;
      } else {
        summary += `❌ ${r.project} - ${r.error || "Error"}\n`;
      }
    });

    const time = new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata"
    });

    summary += `\n🕒 ${time}`;

    // 📲 Send Telegram summary
    sendTelegram(summary);

    res.json({
      status: "completed",
      results
    });

  } finally {
    running = false;
  }
});

app.get("/logs", authenticate, (req, res) => {
  try {
    const logFile = path.join(LOG_DIR, "backup.log");
    const logs = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, "utf-8")
      : "No logs yet";

    res.json({ logs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/clear-logs", authenticate, (req, res) => {
  // simple protection (optional IP check)
  const ip = req.ip;

  if (process.env.NODE_ENV === "production" && !ip.includes("::1")) {
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    const logFile = path.join(LOG_DIR, "backup.log");

    fs.writeFileSync(logFile, "");
    log("=== LOGS CLEARED MANUALLY ===");

    res.json({ status: "Logs cleared" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function getISTTime() {
  return new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata"
  });
}

app.get("/projects", authenticate, (req, res) => {
  const data = projects.map(p => {
    let lastRun = "Never";

    if (fs.existsSync(p.lastRunFile)) {
      try {
        const json = JSON.parse(fs.readFileSync(p.lastRunFile));
        lastRun = new Date(json.date).toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata"
        });
      } catch {}
    }

    return {
      name: p.name,
      lastRun
    };
  });

  res.json({ projects: data });
});

app.get("/run-project", authenticate, async (req, res) => {
  const name = req.query.name;

  const project = projects.find(p => p.name === name);

  if (!project) {
    return res.status(404).json({ error: "Project not found" });
  }

  try {
    await runBackup(project);
    markRun(project.lastRunFile);

    res.json({ status: `Backup done for ${name}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use(express.static("public"));

// ----------------------------
// SCHEDULER (RENDER FRIENDLY)
// ----------------------------
setInterval(checkAndRun, 6 * 60 * 60 * 1000);
checkAndRun();

// ----------------------------
// START SERVER
// ----------------------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  log(`Server running on port ${PORT}`);
});