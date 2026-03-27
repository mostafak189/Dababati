# Dababati — Database Setup & Deployment Guide

This guide connects your Dababati app to a **free PostgreSQL database on Neon**
and deploys the backend API on **Render.com** (also free).

---

## PART 1 — Create a Free PostgreSQL Database on Neon

1. Go to **https://neon.tech** and click **Sign Up** (free, no credit card needed).

2. After logging in, click **"New Project"**.
   - Give it a name like `dababati`
   - Choose a region close to you
   - Click **Create Project**

3. On the dashboard, click your project → **Connection Details**.
   You'll see a connection string that looks like:
   ```
   postgresql://username:password@ep-xxxx.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
   **Copy this — you'll need it in Part 2.**

---

## PART 2 — Push Backend Code to GitHub

1. Create a new **GitHub repository** (public or private) called `dababati-backend`.

2. Push the backend files to it:
   ```bash
   cd dababati-backend
   git init
   git add .
   git commit -m "Initial backend"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/dababati-backend.git
   git push -u origin main
   ```

---

## PART 3 — Deploy on Render.com

1. Go to **https://render.com** and sign in (free tier available).

2. Click **"New +"** → **"Web Service"**.

3. Connect your GitHub account and select the `dababati-backend` repository.

4. Fill in the settings:
   | Field | Value |
   |---|---|
   | **Name** | `dababati-backend` |
   | **Runtime** | `Node` |
   | **Build Command** | `npm install` |
   | **Start Command** | `node server.js` |
   | **Instance Type** | `Free` |

5. Scroll down to **Environment Variables** and add:
   | Key | Value |
   |---|---|
   | `DATABASE_URL` | *(paste your Neon connection string from Part 1)* |

6. Click **"Create Web Service"**.

7. Wait ~2 minutes for the build to finish.
   You'll get a URL like: `https://dababati-backend.onrender.com`

---

## PART 4 — Update Your HTML File

Open `dababati.html` and find this line near the top of the `<script>` section:

```javascript
const API = 'https://YOUR-APP-NAME.onrender.com';
```

Replace it with your actual Render URL:

```javascript
const API = 'https://dababati-backend.onrender.com';
```

Save the file. That's it — your HTML now talks to the real database!

---

## PART 5 — Deploy Your HTML

Your `dababati.html` is a standalone file. You can host it anywhere:

- **Render Static Site**: Add a second Render service as a "Static Site",
  point it to a folder containing just `dababati.html`.
- **GitHub Pages**: Push `dababati.html` to a repo and enable Pages.
- **Netlify Drop**: Drag-and-drop the file at https://app.netlify.com/drop.

---

## What the Database Looks Like

```
TABLE: counter
  id    (always 1)
  value (0–999)

TABLE: comments
  id            (unique string)
  parent_id     (null = top-level, set = reply to parent)
  name          (commenter's callsign)
  text          (message body)
  reply_to_name (display name of who they're replying to)
  likes         (like count)
  created_at    (timestamp — rows older than 3 days are auto-deleted)
```

---

## ⚠️  Free Tier Notes

- **Neon free tier**: 0.5 GB storage, plenty for a comment section.
- **Render free tier**: The web service **spins down after 15 minutes of inactivity**
  and takes ~30 seconds to wake up on the next request. Upgrade to Render's
  "Starter" plan ($7/month) to keep it always-on.
- The app handles the spin-down gracefully — it just shows a brief loading delay.
