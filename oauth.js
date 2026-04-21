import express from "express";
import { google } from "googleapis";
import open from "open";
import dotenv from "dotenv";

dotenv.config();

const app = express();

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "http://localhost:3000/oauth2callback"
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: ["https://www.googleapis.com/auth/drive"],
});

console.log("Opening login...");
open(authUrl);

app.get("/oauth2callback", async (req, res) => {
  const code = req.query.code;

  const { tokens } = await oauth2Client.getToken(code);

  console.log("\nSAVE THIS REFRESH TOKEN:\n");
  console.log(tokens.refresh_token);

  res.send("OK. You can close this window.");

  process.exit(0);
});

app.listen(3000, () => {
  console.log("OAuth running on http://localhost:3000");
});