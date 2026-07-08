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
4. **Give the scraper its secrets:** GitHub repo **Settings** -> **Secrets and
   variables** -> **Actions** -> add four repository secrets:
   - `DISCORD_TOKEN` (the bot token)
   - `DISCORD_GUILD_ID` (the server id)
   - `SUPABASE_URL` (Project URL)
   - `SUPABASE_SERVICE_ROLE_KEY` (the secret key)
5. The scrape workflow (`.github/workflows/scrape.yml`) runs every ~5 minutes.
   Turn it **off** in the Actions tab when no game is running; run it manually
   there any time.

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
