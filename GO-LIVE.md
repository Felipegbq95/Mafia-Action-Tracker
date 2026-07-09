# Go live - step by step

Everything below is click-level. There are three pieces to set up once
(Supabase, the dashboard, the scraper), then a short routine per game.

## 1. Supabase (the database) - once

1. Go to [supabase.com](https://supabase.com), sign in, **New project** (free
   tier is fine). Wait for it to finish provisioning.
2. Left sidebar -> **SQL Editor** -> **New query**. Open `db/schema.sql` from
   this repo, copy the whole file, paste it in, click **Run**. You should see
   "Success". (That is the entire database setup - there is no host password.)
   - **If you get an error like "column status does not exist"**, this project
     already has an older version of the schema. Run `db/reset.sql` first (a
     New query, paste, Run - it clears the old tables), then run `schema.sql`
     again. reset.sql deletes any existing games, so only use it on a test
     project.
3. Left sidebar -> **Project Settings** -> **API**. Copy three values:
   - **Project URL**
   - **anon public** key (safe to expose)
   - **service_role** key (secret - only the scraper uses it)

## 2. The dashboard (the website) - once

1. In this repo, open `dashboard/config.js` and paste in your **Project URL**
   and the **anon** key (not service_role). Commit that change.
2. On GitHub: repo **Settings** -> **Pages** -> under "Build and deployment",
   set **Source** to **GitHub Actions**.
3. Merge this branch into `main`. That triggers the deploy workflow, and your
   dashboard goes live at:
   `https://felipegbq95.github.io/Mafia-Action-Tracker/`

At this point you can already open the site, **Create game**, and add
players/abilities by hand - no Discord needed.

## 3. The scraper (reads Discord) - once per Discord server

1. **Bot token:** [Discord Developer Portal](https://discord.com/developers/applications)
   -> New Application -> **Bot** -> enable **Message Content Intent** ->
   **Reset Token** and copy it.
2. **Invite it:** OAuth2 -> URL Generator -> scope **bot**, permission
   **Administrator** (simplest for reading the private channels on a throwaway
   game server) -> open the URL -> add it to the game's server.
3. **Server ID:** in Discord, enable Developer Mode (Settings -> Advanced),
   right-click the server icon -> **Copy Server ID**.

There are two ways to actually run the scraper. **The "Scrape now" button in
the dashboard (3a) is the one to use** - it runs on demand, not on a timer, and
never puts secrets in the browser. 3b is an optional backup on a schedule.

### 3a. "Scrape now" button (recommended) - one-time CLI deploy

The button calls a small function that lives inside Supabase itself (a
Supabase Edge Function), so the Discord token and the database's full-access
key stay server-side - never visible in the page. Setting this up needs the
Supabase CLI once, from a terminal on your machine:

1. Install the CLI (pick one):
   ```
   npm install -g supabase
   ```
   or see [supabase.com/docs/guides/cli](https://supabase.com/docs/guides/cli)
   for other options (brew, scoop, etc.).
2. In a clone of this repo:
   ```
   supabase login
   supabase link --project-ref oemqjnxhrppvftugdazs
   ```
   (`login` opens a browser to authorize the CLI; the project ref is the code
   in your Supabase project URL, e.g. `oemqjnxhrppvftugdazs` in
   `supabase.com/dashboard/project/oemqjnxhrppvftugdazs`.)
3. Deploy the function:
   ```
   supabase functions deploy scrape
   ```
4. Give it the two secrets it needs (the database URL and key are provided to
   every function automatically - you only set these two):
   ```
   supabase secrets set DISCORD_TOKEN=your-bot-token DISCORD_GUILD_ID=your-server-id
   ```
5. Done. Open a game in the dashboard and click **Scrape now** in the game bar.
   It reports how many channels/messages it scanned and how many actions it
   inserted, right in the page.

If you ever rotate the Discord token, re-run step 4 with the new value - no
redeploy needed.

### 3b. Scheduled scraping (optional backup)

`.github/workflows/scrape.yml` can also run the scraper every ~5 minutes via
GitHub Actions, independent of the button. Only set this up if you want a
backup that keeps scraping even when nobody has the dashboard open:

1. GitHub repo **Settings** -> **Secrets and variables** -> **Actions** -> add
   four repository secrets: `DISCORD_TOKEN`, `DISCORD_GUILD_ID`,
   `SUPABASE_URL` (Project URL), `SUPABASE_SERVICE_ROLE_KEY`.
2. The workflow is disabled by default - enable it from the **Actions** tab
   when you want it running, and turn it back off between games.

## 4. Running a game

1. Open the dashboard -> **Create game** (name + a 6+ character PIN). Share the
   PIN only with co-hosts.
2. **Players tab:** add each player - display name, their personal Discord
   **channel name**, and any **aliases** (other names people target them by).
3. **Abilities tab:** add the game's abilities - the names players type, the
   **effect** to show, a **type** (kill/save/track/watch/redirect/roleblock or
   none), and an optional **splash** to send targets.
4. During/after the night, the scraper fills in actions automatically. Open the
   **Board**: personal-channel actions are attributed; **shared-channel actions
   (mafia, duos) show up under "Needs an actor"** for you to assign. Click an
   arrow to fix a target or set a **result** (e.g. cop -> non-town).
5. Between nights, bump the night with the **+** next to the night tabs.

## 5. Finishing a game

Click **Finish game**. This removes the PIN and makes the game **public
read-only**, so anyone can open it from the games list and review the final
board without editing anything.
